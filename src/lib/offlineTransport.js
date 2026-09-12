// offlineTransport.js —— 桌面端离线传输层（L1 读缓存 / L2 写队列 / L3 幂等重放）
//
// 【为什么是纯 JS 不是 TS】A4 夹具要在 Node 里直接 import 本模块来跑断言（node scripts/A4-fixtures.mjs）。
// Node 不能直接 import .ts。若把逻辑写成 .ts，夹具就只能再实现一遍 → 两份真相。
// 故本体为纯 JS（无类型语法），类型由兄弟文件 offlineTransport.d.ts 提供，TS 侧体验不变。
// 若 npm run build 报「Cannot find module」，在 tsconfig 加 "allowJs": true 即可（.d.ts 已就位，通常不必）。
//
// 【设计五条铁律】
// 1) 只做传输层，不碰业务：不改 store、不改 electron/commands/、不产生任何本地账本记录。
//    **队列是传输缓冲，不是账本**（A4 有专门断言：入队不得写任何账本 key）。
// 2) 包住 src/lib/api.ts 的 backend 单点导出 → 所有调用方零改动白得离线能力。
// 3) 只有「网络故障」才入队；**任何收到了 HTTP 响应的失败都算业务拒绝，绝不入队**。
// 4) 写通道离线入队前必带 idempotencyKey → 重放由中心库 idemCheck/idemSet 判重。
//    ⚠️ 服务端幂等键 TTL = 15 分钟（见 electron/server.js idemSet）。离线超过 15 分钟的单据，
//    重放时服务端已过期、不再判重；靠「成功即出队 + 顺序重放 + 崩溃后不重发已出队项」保证不重。
//    极端情况（重放中途进程崩溃且超过 TTL）仍可能重复一次 —— 这是已知边界，已在 A4 记录。
// 5) 排除通道离线时明确报错，不静默吞掉（盘点/导入/照片/账号/云/备份/配对/快照/租户同步）。

export const K_QUEUE = 'fi-desk-outbox'
export const K_IDMAP = 'fi-desk-idmap'
export const K_CACHE = 'fi-desk-cache:'
export const CACHE_TTL = 7 * 24 * 3600 * 1000
export const MAX_QUEUE = 300

// 写通道白名单：**与 electron/server.js:808-819 的 WRITE_CHANNELS 逐字对齐**（共 39 个）。
// electron/mobile/app.js:65 有同一份副本（那里注释写「与 electron/server.js 的 WRITE_CHANNELS 对齐」），
// 沿用同一约定：改 server.js 必须同步这三处。A4-fixtures.mjs 会读 server.js 原文断言三者一致，防漂移。
export const WRITE_CHANNELS = [
  'product:create', 'product:update', 'product:batchUpdate', 'product:delete', 'product:mark',
  'inbound:create', 'outbound:confirm', 'outbound:checkout', 'outbound:return', 'outbound:exchange',
  'supplier:create', 'supplier:update', 'supplier:delete', 'supplier:pay',
  'stocktake:create', 'stocktake:updateItem', 'stocktake:complete', 'stocktake:submit', 'import:batch',
  'customer:create', 'customer:update', 'customer:delete', 'payment:record',
  'expense:create', 'expense:update', 'expense:delete', 'waste:create',
  'part:set', 'part:setMany', 'kit:save', 'kit:delete', 'receipt:register',
  'po:create', 'po:receive', 'po:cancel', 'priceTier:set', 'priceTier:delete', 'photo:save', 'photo:delete',
]

// 不可离线排队的写通道：语义上必须当场拿到中心库裁决，排队等于造假。
// 与 electron/mobile/app.js:121 的 NO_QUEUE 同集合（stocktake:* / import:batch / photo:*）。
export const NO_QUEUE = {
  'stocktake:create': '盘点', 'stocktake:updateItem': '盘点', 'stocktake:complete': '盘点', 'stocktake:submit': '盘点',
  'import:batch': '批量导入', 'photo:save': '照片', 'photo:delete': '照片',
}

// 前缀黑名单：账号/云/备份/配对/快照/租户同步一律不排队。
// 依据：老板铁律③「别动 /api/pair、/api/snapshot、/api/backup*」——这些链路宁可失败也不能被离线层改写时序。
export const NO_QUEUE_PREFIX = ['account:', 'auth:', 'cloud:', 'license:', 'pair', 'backup', 'snapshot', 'tenant:', 'sync:', 'update:', 'app:']

// 不缓存读通道：AI 与收款码必须实时，缓存会给出错误结论/过期二维码。
// 与 electron/mobile/app.js:122 的 NO_CACHE 同集合，另加桌面端 AI 前缀。
export const NO_CACHE = { 'ai:chat': 1, 'ai:dailySummary': 1, 'ai:photoDraft': 1, 'payment:getQr': 1 }
export const NO_CACHE_PREFIX = ['ai:']

// 建档类通道：离线时返回 tmp_xxx，后续单据引用它，重放成功后改写为服务端真 id。
// 必须有这一条，否则「新建商品 → 立即入库/开单」在断网时会以 productId: undefined 入队 → 孤儿单据。
// （electron/mobile/offline.js:53-57 是同一机制的手机端实现。）
export const CREATE_CHANNELS = { 'product:create': 1, 'customer:create': 1, 'supplier:create': 1 }

const NET_MSG = /(连不上|网络|断网|fetch failed|Failed to fetch|NetworkError|ERR_NETWORK|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|超时)/i

function memStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    __mem: m,
  }
}

/**
 * 创建离线传输层。返回对象同时是 FiBridge（有 .invoke）与控制面（pendingCount/flush/...）。
 * @param {object} opts
 * @param {object|null} opts.inner        内层真实桥（window.fi 或 http 后端）；null 时 bridge 为 null
 * @param {object} [opts.storage]         注入存储（测试用），默认 localStorage，缺失时退化为内存
 * @param {() => number} [opts.now]       注入时钟（测试用）
 * @param {() => boolean} [opts.online]   注入联网判断（测试用）
 * @param {(pending:number, failed:number) => void} [opts.onPending] 队列变化回调（给横幅用）
 * @param {boolean} [opts.autoFlush]      启动时自动重放一次，默认 true
 */
export function createOffline(opts) {
  const o = opts || {}
  const inner = o.inner || null
  const storage = o.storage || (typeof localStorage !== 'undefined' ? localStorage : memStorage())
  const now = o.now || (() => Date.now())
  const online = o.online || (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false))
  const writeCh = new Set(WRITE_CHANNELS)
  const subs = []
  let flushing = false
  let flushTimer = null

  function raw(k) { try { return storage.getItem(k) } catch { return null } }
  function put(k, v) { try { storage.setItem(k, v) } catch { /* 隐私模式写不进不致命 */ } }
  function del(k) { try { storage.removeItem(k) } catch { /* 同上 */ } }
  function readJSON(k, d) { const s = raw(k); if (!s) return d; try { return JSON.parse(s) } catch { return d } }
  function writeJSON(k, v) { put(k, JSON.stringify(v)) }

  function queue() { const q = readJSON(K_QUEUE, []); return Array.isArray(q) ? q : [] }
  function saveQueue(q) { writeJSON(K_QUEUE, q) }
  function idmap() { const m = readJSON(K_IDMAP, {}); return m && typeof m === 'object' ? m : {} }
  function saveIdmap(m) { writeJSON(K_IDMAP, m) }

  function pendingCount() { const q = queue(); let n = 0; for (const it of q) if (!it.failed) n++; return n }
  function failedCount() { const q = queue(); let n = 0; for (const it of q) if (it.failed) n++; return n }
  function state() { return { pending: pendingCount(), failed: failedCount() } }

  function notify() {
    const s = state()
    for (const cb of subs) { try { cb(s) } catch { /* 订阅者出错不影响队列 */ } }
    if (typeof o.onPending === 'function') { try { o.onPending(s.pending, s.failed) } catch { /* 同上 */ } }
  }
  function subscribe(cb) { subs.push(cb); return () => { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1) } }

  // ---------------- L1 读缓存 ----------------
  function readable(channel) {
    if (writeCh.has(channel)) return false
    if (NO_CACHE[channel]) return false
    for (const p of NO_CACHE_PREFIX) if (channel.indexOf(p) === 0) return false
    // 前缀黑名单通道（账号/云/备份/配对/快照/租户同步）既不许排队、也不许缓存：
    // 断网时若回退到缓存的登录/云结果，会给出错误的登录态或过期数据 —— 宁可失败。
    for (const p of NO_QUEUE_PREFIX) if (channel.indexOf(p) === 0) return false
    return true
  }
  function cacheKey(channel, payload) { return K_CACHE + channel + '|' + JSON.stringify(payload || {}) }
  function cachePut(channel, payload, data) { if (readable(channel)) writeJSON(cacheKey(channel, payload), { at: now(), data: data }) }
  function cacheGet(channel, payload) {
    const hit = readJSON(cacheKey(channel, payload), null)
    if (!hit) return null
    if (now() - hit.at > CACHE_TTL) return null
    return hit
  }

  // ---------------- 故障分类（A3 的核心） ----------------
  // 收到 HTTP 状态 = 服务端已裁决 = 业务结果，绝不入队（除 502/503/504 这类还没进路由的网关错误）。
  function isNetworkError(e) {
    if (!e) return false
    if (e.network === true) return true
    const st = typeof e.status === 'number' ? e.status : (typeof e.statusCode === 'number' ? e.statusCode : null)
    if (st !== null) return st === 502 || st === 503 || st === 504
    if (!online()) return true
    return NET_MSG.test(String(e.message || e))
  }

  function canQueue(channel) {
    if (!writeCh.has(channel)) return false
    if (NO_QUEUE[channel]) return false
    for (const p of NO_QUEUE_PREFIX) if (channel.indexOf(p) === 0) return false
    return true
  }

  function newKey() { return 'd' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }
  function tmpId() { return 'tmp_' + now().toString(36) + Math.random().toString(36).slice(2, 7) }
  function isTmpId(v) { return typeof v === 'string' && v.indexOf('tmp_') === 0 }

  // ---------------- L2 写队列 ----------------
  function queueWrite(channel, payload) {
    const q = queue()
    if (q.length >= MAX_QUEUE) throw new Error('离线单据太多（' + MAX_QUEUE + ' 笔），先连网重传再继续记账')
    const item = {
      id: 'd' + now().toString(36) + Math.random().toString(36).slice(2, 6),
      channel: channel, payload: payload, at: now(), tries: 0, failed: false, err: '', tmpId: null,
    }
    if (CREATE_CHANNELS[channel]) item.tmpId = tmpId()
    q.push(item); saveQueue(q); notify()
    const res = { ok: true, offline: true, queued: true, clientDocId: item.id, at: item.at }
    if (item.tmpId) res.id = item.tmpId
    return res
  }

  function excludedMessage(channel) {
    const label = NO_QUEUE[channel] || '这个操作'
    return label + '需要联网（不能离线记账），连上网再试'
  }

  // 深改写：把载荷里引用 tmp_xxx 的字段换成服务端真 id；依赖项还没上传成功则返回 null。
  function resolve(v, m, depth) {
    const d = depth || 0
    if (d > 12) return v
    if (isTmpId(v)) return Object.prototype.hasOwnProperty.call(m, v) ? m[v] : null
    if (Array.isArray(v)) {
      const out = []
      for (const x of v) { const r = resolve(x, m, d + 1); if (r === null && isTmpId(x)) return null; out.push(r) }
      return out
    }
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v)) { const r = resolve(v[k], m, d + 1); if (r === null && isTmpId(v[k])) return null; out[k] = r }
      return out
    }
    return v
  }

  // ---------------- L3 幂等重放 ----------------
  async function flush() {
    if (flushing) return { done: 0, left: pendingCount() }
    if (!inner) return { done: 0, left: pendingCount() }
    if (!online()) return { done: 0, left: pendingCount() }
    flushing = true
    let done = 0
    try {
      const q = queue(); const m = idmap()
      // 迭代预算：本轮最多处理「进入本轮时的条数 + 1」次。
      // 正常路径下每个分支都会推进 i 或 splice，永远撞不到预算；
      // 但只要将来有人改错一步（例如忘了出队），没有预算就是死循环 + 界面卡死。
      // A4 夹具的 --mutate=dedupe 就是靠这个预算才终止并把变异杀死。
      const budget = q.length + 1
      let i = 0
      let steps = 0
      while (i < q.length && steps < budget) {
        steps++
        const it = q[i]
        if (it.failed) { i++; continue }
        const rp = resolve(it.payload, m, 0)
        if (rp === null) { it.err = '依赖的离线单据还没上传成功'; it.tries++; i++; continue }
        try {
          const out = await inner.invoke(it.channel, rp)
          if (it.tmpId && out && out.id != null) m[it.tmpId] = out.id
          q.splice(i, 1); done++            // 成功即出队：队列是缓冲，不是账本
        } catch (e) {
          it.tries++
          if (isNetworkError(e)) { saveQueue(q); saveIdmap(m); break }  // 还断网：本轮到此为止，剩余保留、顺序不乱
          it.failed = true; it.err = String(e.message || e); i++        // 业务拒绝：标记失败不再重试，交人处理
        }
      }
      saveQueue(q); saveIdmap(m); notify()
      return { done: done, left: pendingCount() }
    } finally { flushing = false }
  }

  function scheduleFlush(delay) {
    if (typeof setTimeout === 'undefined') return
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => { flushTimer = null; flush() }, delay == null ? 500 : delay)
  }

  // ---------------- 对外 invoke（FiBridge 形状） ----------------
  async function invoke(channel, payload) {
    if (!inner) throw new Error('本地模式：没有可用的后端')
    const p = payload && typeof payload === 'object' ? Object.assign({}, payload) : {}
    const writing = writeCh.has(channel)
    if (writing && !p.idempotencyKey) p.idempotencyKey = newKey()
    try {
      const out = await inner.invoke(channel, p)
      // 用「原始 payload」做缓存键（不带我们注入的幂等键），保证调用方自己读回时键一致
      if (!writing) cachePut(channel, payload, out)
      if (pendingCount() > 0) scheduleFlush(500)   // 网络恢复了：顺手把攒下的传上去
      return out
    } catch (e) {
      if (!isNetworkError(e)) throw e              // 业务拒绝：原样抛给调用方（页面要显示原因）
      if (writing) {
        if (!canQueue(channel)) throw new Error(excludedMessage(channel))
        return queueWrite(channel, p)
      }
      const hit = readable(channel) ? cacheGet(channel, payload) : null
      if (hit) {
        const res = hit.data
        // 只读回退时给一个可探测标记，方便页面/断言区分「实时」与「上次缓存」，但绝不改业务字段
        if (res && typeof res === 'object' && !Array.isArray(res)) return Object.assign({}, res)
        return res
      }
      throw e
    }
  }

  const bridge = inner
    ? {
        invoke: invoke,
        onVoiceProgress: inner.onVoiceProgress ? inner.onVoiceProgress.bind(inner) : undefined,
        onTtsProgress: inner.onTtsProgress ? inner.onTtsProgress.bind(inner) : undefined,
        onKwsProgress: inner.onKwsProgress ? inner.onKwsProgress.bind(inner) : undefined,
      }
    : null

  const api = {
    bridge: bridge,
    invoke: invoke,
    pendingCount: pendingCount,
    failedCount: failedCount,
    state: state,
    subscribe: subscribe,
    flush: flush,
    scheduleFlush: scheduleFlush,
    queueDump: () => queue(),
    idmapDump: () => idmap(),
    isTmpId: isTmpId,
    canQueue: canQueue,
    readable: readable,
    isNetworkError: isNetworkError,
    // 仅供测试/人工清场：清失败项 / 清空队列 / 清 id 映射
    dropFailed: () => { const q = queue().filter((it) => !it.failed); saveQueue(q); notify(); return q.length },
    clearQueue: () => { saveQueue([]); notify() },
    clearIdmap: () => { del(K_IDMAP) },
    clearCache: () => {
      // 只清自己的前缀，不动别人的 key
      const ls = storage
      if (ls && typeof ls.length === 'number' && typeof ls.key === 'function') {
        const kill = []
        for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.indexOf(K_CACHE) === 0) kill.push(k) }
        for (const k of kill) del(k)
      } else if (ls && ls.__mem) {
        for (const k of Array.from(ls.__mem.keys())) if (k.indexOf(K_CACHE) === 0) ls.__mem.delete(k)
      }
    },
  }

  // 联网恢复自动重放 + 启动先补一次
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', () => { flush() })
  }
  if (o.autoFlush !== false && typeof window !== 'undefined') scheduleFlush(1500)

  return api
}

/** 便捷包装：直接拿 FiBridge（api.ts 只用这个），控制面单独 createOffline 取。 */
export function wrapOffline(inner, opts) {
  return createOffline(Object.assign({}, opts || {}, { inner: inner })).bridge
}

// 只暴露**模块作用域**的东西给测试。
// ⚠️ resolve / isNetworkError 定义在 createOffline 内部（要闭包 online 状态），
//    这里绝不能引用它们 —— 否则模块一 import 就 ReferenceError。
//    逐实例的判定请用 api.isNetworkError / api.canQueue / api.readable。
export const __testables = { memStorage: memStorage, NET_MSG: NET_MSG }
