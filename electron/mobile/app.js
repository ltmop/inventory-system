// app.js: 手机端框架 —— 路由 / fetch / token / 组件 / 印章动画 / toast
// 视觉：通用进销存 · 纸质感 · 贴纸收款键 · 印章反馈

// 诊断：任何 JS 报错显示到页面，方便定位问题（修好后可保留，不干扰正常使用）
window.addEventListener('error', function (e) {
  try {
    var app = document.getElementById('app')
    if (app && app.innerHTML.indexOf('JS错误') < 0) {
      app.innerHTML = '<div style="padding:20px;color:#ff6b6b;font-size:13px">JS错误: ' + (e.message || '未知') + '</div>'
    }
  } catch (err) { /* 忽略 */ }
})

// token 持久化：优先从 URL 拿（扫码打开时带 token），其次从 localStorage 取（上次记住的），
// 都没有才提示重新扫码。首次扫码打开时自动记住，之后关闭页面/加到主屏幕都能直接重开。
const TOKEN = (() => {
  const fromUrl = new URLSearchParams(location.search).get('token')
  if (fromUrl) {
    try { localStorage.setItem('fi-mobile-token', fromUrl) } catch { /* 存不住不致命 */ }
    return fromUrl
  }
  try { return localStorage.getItem('fi-mobile-token') || '' } catch { return '' }
})()
// 平台自适应（唯一 shim）：APK 由 index.html 注入 window.__FI_SERVER__ 指向中心库；
// 官网与局域网 /m/ 不加注入 = SERVER 留空 = 同源。两端共用同一个 app.js，不做第二份副本。
function readStoredServer() { try { return localStorage.getItem('fi-server') || '' } catch (e) { return '' } }
// 优先用店主粘进来的地址（存在本机），否则用构建时注入的地址；官网/局域网 /m/ 两者都没有 = 留空 = 同源。
let SERVER = readStoredServer() || (typeof window !== 'undefined' && window.__FI_SERVER__) || ''
// ========== 图标库：界面里一律用内联 SVG，不用 emoji ==========
// 口径：1.15em 跟着文字大小走、跟文字同色（stroke:currentColor），统一 1.8 描边、圆角线帽。
const ICON = {
  cart: '<path d="M4 5h2l2.2 10.2A1.8 1.8 0 0 0 10 16.6h8.2a1.8 1.8 0 0 0 1.76-1.44L21.5 8H7"/><circle cx="10.5" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5 16 16"/>',
  camera: '<path d="M4 8.5h3l1.6-2.2h6.8L17 8.5h3V19H4z"/><circle cx="12" cy="13.5" r="3.2"/>',
  sparkle: '<path d="M12 4.2 13.7 9l4.8 1.7-4.8 1.7L12 17.2l-1.7-4.8L5.5 10.7 10.3 9z"/><path d="M18.6 4.4v2.6M17.3 5.7h2.6"/>',
  chart: '<path d="M4 19V5M4 19h16"/><path d="M8 19v-6M12.5 19V9M17 19v-9"/>',
  alert: '<path d="M12 4.6 21 19.4H3z"/><path d="M12 10v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 1.8"/>',
  trash: '<path d="M5 7h14M10 7V4.8h4V7M8 7l1 12.2h6L16 7"/><path d="M10.5 11v5M13.5 11v5"/>',
  clipboard: '<rect x="6" y="4.6" width="12" height="15.8" rx="2.6"/><path d="M9.5 4.6V3.4h5v1.2M9 10h6M9 13.8h4"/>',
  box: '<path d="M12 3.4 20 8v8l-8 4.6L4 16V8z"/><path d="M4 8l8 4.5L20 8M12 12.5v8"/>',
  users: '<circle cx="9" cy="9" r="3.2"/><path d="M3.6 19c0-3 2.4-5.2 5.4-5.2S14.4 16 14.4 19"/><path d="M15.8 6.4a3 3 0 0 1 0 5.6M17 19c0-1.9.5-3.4 1.5-4.4"/>',
  receipt: '<path d="M6 3.6h12v16.8l-3-1.8-3 1.8-3-1.8-3 1.8z"/><path d="M9 8.4h6M9 12.2h6"/>',
  wallet: '<path d="M4 7.6A2.6 2.6 0 0 1 6.6 5H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6.6A2.6 2.6 0 0 1 4 16.4z"/><path d="M4 9.2h16"/><circle cx="16" cy="14" r="1.1"/>',
  truck: '<path d="M3 7h10v9H3z"/><path d="M13 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/>',
  share: '<circle cx="17.5" cy="6.5" r="2.4"/><circle cx="6.5" cy="12" r="2.4"/><circle cx="17.5" cy="17.5" r="2.4"/><path d="M8.7 10.9 15.2 7.8M8.7 13.1l6.5 3.1"/>',
  pulse: '<path d="M3 12.5h4l2-6.5 3 12.5 2.4-8 1.6 4H21"/>',
  type: '<path d="M5 6.6V5h14v1.6M12 5v14M9 19h6"/>',
  refresh: '<path d="M19.6 11a7.8 7.8 0 1 0-2.2 6.1"/><path d="M19.8 5.6V11h-5.4"/>',
  undo: '<path d="M8.5 8.5H4V4"/><path d="M4.4 8.4A7.8 7.8 0 1 1 4 13"/>',
  link: '<path d="M10.2 13.8a3.8 3.8 0 0 1 0-5.4l2.3-2.3a3.8 3.8 0 0 1 5.4 5.4l-1.4 1.4"/><path d="M13.8 10.2a3.8 3.8 0 0 1 0 5.4l-2.3 2.3a3.8 3.8 0 0 1-5.4-5.4l1.4-1.4"/>',
  logout: '<path d="M15 5.2H7.4A2.2 2.2 0 0 0 5.2 7.4v9.2A2.2 2.2 0 0 0 7.4 18.8H15"/><path d="M18.5 12H9.6M15.4 8.6 18.8 12l-3.4 3.4"/>',
  plus: '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
  minus: '<path d="M5.2 12h13.6"/>',
  close: '<path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6"/>',
  chevron: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  check: '<path d="M4.8 12.6 9.6 17.4 19.2 6.6"/>',
  phone: '<path d="M6 3.6h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A15.6 15.6 0 0 1 4 6.8 2 2 0 0 1 6 3.6Z"/>',
  tag: '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.4" cy="8.4" r="1.3"/>',
  edit: '<path d="M4.5 19.5h4L20 8l-4-4L4.5 15.5z"/><path d="M14.6 5.4 18.6 9.4"/>',
  download: '<path d="M12 4v10.6"/><path d="M8.2 11 12 14.8 15.8 11"/><path d="M5 19h14"/>',
  store: '<path d="M4 9.4 6.2 5h11.6L20 9.4"/><path d="M4.6 9.4h14.8V19H4.6z"/><path d="M9.6 19v-5h4.8v5"/>',
  user: '<circle cx="12" cy="8.4" r="3.4"/><path d="M5.2 19.6c0-3.5 3-5.8 6.8-5.8s6.8 2.3 6.8 5.8"/>',
  bolt: '<path d="M13.2 3 5.6 13.2h5.2L10 21l7.6-10.2h-5.2z"/>',
  fish: '<path d="M3.5 12S7.5 7 12.2 7c4 0 7.3 5 7.3 5s-3.3 5-7.3 5C7.5 17 3.5 12 3.5 12Z"/><circle cx="15.4" cy="11" r="1"/><path d="M3.5 12 1.6 9.2v5.6z"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
}
/** 取一个内联 SVG 图标（size 用 px；不传就跟当前字号走） */
function FiIcon(name, size) {
  const inner = ICON[name] || ICON.dot
  const s = size ? ' width="' + size + '" height="' + size + '"' : ''
  return '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' + s + '>' + inner + '</svg>'
}
// 底部弹层（白卡 + 圆角 + 回弹入场），分享/使用情况/字号都复用它
function sheet(title, bodyHtml) {
  const ov = document.createElement('div')
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.42);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);z-index:340;display:flex;align-items:flex-end;justify-content:center'
  ov.innerHTML = '<div class="sheet" style="width:100%;max-width:430px;background:var(--card);border-radius:var(--r-xl) var(--r-xl) 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom));max-height:88vh;overflow:auto">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">' +
      '<div style="font-size:16px;font-weight:800;flex:1">' + escHtml(title) + '</div>' +
      '<button data-close style="width:32px;height:32px;border-radius:50%;border:none;background:var(--line2);color:var(--ink2);display:flex;align-items:center;justify-content:center">' + FiIcon('close', 16) + '</button>' +
    '</div>' + bodyHtml + '</div>'
  document.body.appendChild(ov)
  ov.onclick = function (e) { if (e.target === ov) ov.remove() }
  ov.querySelector('[data-close]').onclick = function () { ov.remove() }
  return ov
}

const COLORS = ["#0e9f6e","#b7791f","#1677ff","#7c3aed","#d64545","#0e7490","#be185d","#3f6212","#9a3412"]

// 防请求风暴：只有连接码失效(401)才全局标记锁死（横幅会引导到「更多 - 连接设置」重输）；
// 普通网络抖动（断网/超时）不锁死，让单次请求失败后可以重试——否则 WiFi 一抖手机端就全瘫
let tokenFailed = false
const READ_TIMEOUT_MS = 8000  // 读操作：8 秒足够，再久用户就以为卡死了
// 少数「慢读」通道要单独放宽：拍单据识别视觉模型要 3~60 秒，8 秒会必超时。
// 这些通道也不进离线缓存（结果是一次性的识别，不是可复用的账本数据）。
const SLOW_CHANNELS = { 'ai:parseInboundNote': 150000 }
const WRITE_TIMEOUT_MS = 15000 // 写操作：给足时间；重发有幂等键兜底，不会重复记账

// 顶部连接横幅：断网/连接失败时大白话提醒，连上后自动隐藏
function showNetBanner(text, color, onRetry) {
  try {
    const b = document.getElementById('netBanner')
    if (!b) return
    b.style.background = color || '#fff3cd'
    b.style.color = '#8a6d00'
    b.style.display = 'block'
    b.innerHTML = ''
    const sp = document.createElement('span'); sp.textContent = text
    b.appendChild(sp)
    if (onRetry) {
      const btn = document.createElement('button')
      btn.textContent = '重试'; btn.type = 'button'
      btn.style.cssText = 'margin-left:10px;padding:3px 12px;border:none;border-radius:6px;background:#8a6d00;color:#fff;font-weight:800;font-size:13px;cursor:pointer'
      btn.onclick = onRetry
      b.appendChild(btn)
    }
  } catch {}
}
function hideNetBanner() {
  try {
    const b = document.getElementById('netBanner')
    if (b) b.style.display = 'none'
  } catch {}
}


// 写通道白名单：与 electron/server.js 的 WRITE_CHANNELS 对齐。
// 写操作一律带 idempotencyKey —— 服务端 15 分钟内同 key 返回原结果，
// 断网重试 / 双击 / 超时重发都不会重复扣库存、重复记账。
const WRITE_CHANNELS = {
  'product:create': 1, 'product:update': 1, 'product:batchUpdate': 1, 'product:delete': 1, 'product:mark': 1,
  'inbound:create': 1, 'inbound:fromNote': 1, 'outbound:confirm': 1, 'outbound:checkout': 1, 'outbound:return': 1, 'outbound:exchange': 1,
  'supplier:create': 1, 'supplier:update': 1, 'supplier:delete': 1, 'supplier:pay': 1,
  'stocktake:create': 1, 'stocktake:updateItem': 1, 'stocktake:complete': 1, 'stocktake:submit': 1, 'import:batch': 1,
  'customer:create': 1, 'customer:update': 1, 'customer:delete': 1, 'payment:record': 1,
  'expense:create': 1, 'expense:update': 1, 'expense:delete': 1, 'waste:create': 1,
  'part:set': 1, 'part:setMany': 1, 'kit:save': 1, 'kit:delete': 1, 'receipt:register': 1,
  'po:create': 1, 'po:receive': 1, 'po:cancel': 1, 'priceTier:set': 1, 'priceTier:delete': 1, 'photo:save': 1, 'photo:delete': 1,
}
function newIdemKey() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
const inflightWrites = {}

let netDown = false
// 原始调用：鉴权 / 3 次重试 / HTTP，不含离线兜底（离线重放也复用它）。
// 网络类失败会带 .network=true，业务拒绝（4xx）不带 —— 只有前者才进离线层。
async function invokeRaw(channel, payload) {
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(function () { controller.abort() }, SLOW_CHANNELS[channel] || (WRITE_CHANNELS[channel] ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS))
    let r
    try {
      r = await fetch(SERVER + '/api/invoke?token=' + TOKEN, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, payload: payload || {} }),
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      netDown = true
      lastErr = new Error((e && e.name === 'AbortError') ? '请求超时，正在重试' : '连不上店里的账本，检查手机网络')
      lastErr.network = true
      showNetBanner('连不上店里的账本，检查网络后重试', '#ffe9d6', function () { hideNetBanner(); renderPage(true) })
      await sleep(700 * (attempt + 1))
      continue
    }
    clearTimeout(timer)
    const data = await r.json().catch(function () { return {} })
    if (netDown && r.ok) { netDown = false; hideNetBanner() }
    if (r.status === 401) {
      // 中心库换过连接码就会 401：重输旧码没用。
      // ① 有设备令牌 → 自动换当前有效的新码并重连（用户无感）；
      // ② 没有（当初用连接码接入的）→ 引导用账号密码登录，登录后也会存下设备令牌，以后同样自动恢复。
      tokenFailed = true
      if (!selfHealTried) {
        selfHealTried = true
        const fixed = await refreshCentralToken()
        if (fixed) { toast('店里换过连接码，已自动更新，正在重连…'); setTimeout(function () { location.reload() }, 400); throw new Error('连接码已自动更新') }
      }
      showNetBanner('登录已过期（店里换过连接码）· 点这里用账号密码重新登录', '#ffdede', function () { openLoginPanel(false, 'stale') })
      throw new Error(data.error || '登录已过期，请用账号密码重新登录')
    }
    if (r.status >= 500 && attempt < 2) {
      lastErr = new Error(data.error || '服务端繁忙，正在重试'); lastErr.network = true
      await sleep(700 * (attempt + 1)); continue
    }
    if (!r.ok) throw new Error(data.error || '请求失败')
    return data.result
  }
  throw lastErr || new Error('请求失败')
}

// 离线层接线：写通道断网进队列、读通道断网用上次缓存，联网后按序幂等重放。
const NO_QUEUE = { 'stocktake:create': 1, 'stocktake:submit': 1, 'stocktake:complete': 1, 'import:batch': 1, 'photo:save': 1, 'photo:delete': 1 }
const NO_CACHE = { 'ai:chat': 1, 'ai:dailySummary': 1, 'ai:photoDraft': 1, 'ai:parseInboundNote': 1, 'payment:getQr': 1 }
function updateOfflineBanner(pending, failed) {
  const n = pending === undefined ? Offline.pendingCount() : pending
  const f = failed === undefined ? Offline.failedCount() : failed
  if (!n && !f) { if (!netDown) hideNetBanner(); return }
  const txt = f ? ('有 ' + f + ' 笔被中心库拒绝，点开处理（另有 ' + n + ' 笔待上传）') : ('离线 ' + n + ' 笔待上传，点开可重传')
  showNetBanner(txt, f ? '#ffdede' : '#fff3cd', function () { Offline.openPanel() })
}
Offline.init({ invoke: invokeRaw, writeChannels: WRITE_CHANNELS, noQueue: NO_QUEUE, noCache: NO_CACHE, onPending: updateOfflineBanner })
function flushOffline() { if (Offline.pendingCount()) Offline.flush() }
// 同步读上次缓存（离线层 L1）：页面首帧先用它渲染，网络结果回来再覆盖 —— 切页不再闪「加载中」
function apiCached(channel, payload) {
  if (!Offline.readable(channel)) return null
  const hit = Offline.cacheGet(channel, payload)
  return hit ? hit.data : null
}

// opts.idempotencyKey：调用方自带的幂等键（开单页按购物车复用），不传则自动生成。
// 写通道遇网络故障会带同一个 key 自动重试 3 次；飞行中的同内容写操作只发一次（双击去重）。
async function api(channel, payload, opts) {
  if (tokenFailed) throw new Error('登录已过期，请用账号密码重新登录（更多 → 登录账号）')
  if (!TOKEN) throw new Error('还没登录：请用账号密码登录（或用店主给的连接码/扫码接入）')
  const p = Object.assign({}, payload || {})
  const isWrite = !!WRITE_CHANNELS[channel]
  if (isWrite && !p.idempotencyKey) p.idempotencyKey = (opts && opts.idempotencyKey) || newIdemKey()
  const sig = Object.assign({}, p); delete sig.idempotencyKey
  const flightKey = isWrite ? channel + '|' + JSON.stringify(sig) : ''
  if (flightKey && inflightWrites[flightKey]) return inflightWrites[flightKey]
  const gen = renderGen
  const stale = function () { return new Promise(function () {}) } // 已切页：结果丢弃（永不落地）
  const run = (async function () {
    try {
      const out = await invokeRaw(channel, p)
      if (Offline.readable(channel)) Offline.cachePut(channel, p, out)
      if (Offline.pendingCount()) setTimeout(flushOffline, 500) // 网络已恢复：顺手把攒下的单据传上去
      if (gen !== renderGen) return stale()
      return out
    } catch (e) {
      if (!e || !e.network) { if (gen !== renderGen) return stale(); throw e } // 业务拒绝：只对当前页有意义
      if (isWrite && Offline.canQueue(channel)) { const q = Offline.queueWrite(channel, p); return gen !== renderGen ? stale() : q }
      if (isWrite) throw new Error('这个操作需要联网（盘点/批量导入不能离线记账），连上网再试')
      const hit = Offline.readable(channel) ? Offline.cacheGet(channel, p) : null
      if (hit && gen !== renderGen) return stale()
      if (hit) { toast('离线：显示上次的数据（' + new Date(hit.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '）'); return hit.data }
      throw e
    }
  })()
  if (flightKey) {
    inflightWrites[flightKey] = run
    const done = function () { delete inflightWrites[flightKey] }
    run.then(done, done)
  }
  return run
}
// —— 操作员身份（T2 统一）：全手机页写操作共用同一个 getOperator()，发货/开单/入库/报损都能追到人 ——
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] }) }
function getOperator() { try { return localStorage.getItem('fi-operator') || '老板' } catch { return '老板' } }
// 记住用过的名字：多人共用一台手机时，换人只要点一下，不用每次打字
function getOperators() { try { const v = JSON.parse(localStorage.getItem('fi-operators') || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }
function rememberOperator(n) {
  const s = String(n == null ? '' : n).trim()
  if (!s) return
  const list = getOperators().filter(function (x) { return x !== s })
  list.unshift(s)
  try { localStorage.setItem('fi-operators', JSON.stringify(list.slice(0, 12))) } catch (e) {}
}
function setOperator(n) {
  const s = String(n == null ? '' : n).trim() || '老板'
  try { localStorage.setItem('fi-operator', s) } catch (e) {}
  rememberOperator(s)
}
// 操作员面板：点名字即切换（开单/入库/报损都会记到这个名字上）
function openOperatorPanel() {
  const old = document.getElementById('op-panel'); if (old) old.remove()
  const cur = getOperator()
  const known = getOperators()
  if (known.indexOf(cur) < 0) known.unshift(cur)
  const ov = document.createElement('div')
  ov.id = 'op-panel'
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.96);z-index:310;padding:22px;color:#e6edf5;overflow:auto'
  let h = '<div style="font-size:22px;font-weight:800;margin-bottom:6px">这台手机现在谁在用？</div>' +
    '<div style="font-size:14px;color:#8fa3c0;line-height:1.7;margin-bottom:18px">开单、入库、报损都会记在这个名字上，方便对账到人</div>'
  known.forEach(function (n, i) {
    const on = n === cur
    h += '<button data-oi="' + i + '" style="width:100%;height:60px;margin-bottom:10px;border-radius:14px;border:2px solid ' + (on ? '#d4af37' : 'rgba(255,255,255,.2)') + ';background:' + (on ? 'linear-gradient(135deg,#c9a55a,#d4af37)' : 'rgba(255,255,255,.08)') + ';color:' + (on ? '#0a1628' : '#e6edf5') + ';font-size:19px;font-weight:800">' + escHtml(n) + (on ? ' · 正在用' : '') + '</button>'
  })
  h += '<input id="op-new" placeholder="换个人：输个名字" autocomplete="off" style="width:100%;height:58px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);border-radius:12px;color:#fff;font-size:18px;padding:0 14px;margin:8px 0 12px;outline:none">' +
    '<button id="op-save" style="width:100%;height:58px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:18px;font-weight:800">就用这个名字</button>' +
    '<button id="op-close" style="width:100%;height:50px;margin-top:10px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px">取消</button>'
  ov.innerHTML = h
  document.body.appendChild(ov)
  function pick(name) {
    setOperator(name)
    ov.remove()
    toast('已切换操作员：' + getOperator())
    renderPage(true)
  }
  ov.querySelectorAll('[data-oi]').forEach(function (b) { b.onclick = function () { pick(known[Number(b.getAttribute('data-oi'))]) } })
  ov.querySelector('#op-save').onclick = function () {
    const v = (ov.querySelector('#op-new').value || '').trim()
    if (!v) { toast('先输个名字'); return }
    pick(v)
  }
  ov.querySelector('#op-close').onclick = function () { ov.remove() }
  setTimeout(function () { const i = ov.querySelector('#op-new'); if (i) i.focus() }, 120)
}

// —— 连接店铺账本（手机端唯一接入入口）：粘连接码、粘整条链接、或扫二维码，都不用打长串 ——
// 连接码的真实格式是 32 位小写 hex（server.js 的 /^[0-9a-f]{32}$/ 是权威定义）：能抓到就直接用，
// 抓不到才退回通用清洗；清洗只删「绝不可能出现在连接码里」的字符（空白/引号/中文标点/汉字），不猜内容。
function sanitizeToken(s) {
  const str = String(s == null ? '' : s)
  const mHex = str.match(/[0-9a-f]{32}/)
  if (mHex) return mHex[0]
  return str.replace(/[\s"'`<>\u300a\u300b\uff0c\u3002\uff1b\u3001:\uff1a=\uff1d]/g, '').replace(/[\u4e00-\u9fa5]/g, '')
}
function parseConnectInput(raw) {
  const out = { token: '', server: '' }
  let s = String(raw == null ? '' : raw).trim()
  if (!s) return out
  const mUrl = s.match(/https?:\/\/[^\s"']+/i)
  if (mUrl) {
    try {
      const u = new URL(mUrl[0])
      out.server = u.origin
      const t = u.searchParams.get('token')
      if (t) { out.token = sanitizeToken(t); return out }
    } catch (e) {}
    s = s.replace(mUrl[0], ' ')   // 整条链接里没有 token 参数：剩下部分继续按连接码解析
  }
  const mTok = s.match(/(?:token|连接码|访问码)\s*[:=：]?\s*([A-Za-z0-9._\-]+)/i)
  if (mTok) s = mTok[1]
  out.token = sanitizeToken(s)
  return out
}
// ========== 账号密码登录（与桌面端同一套账号）==========
// 电脑端登录走的是 POST https://sync.junchengzn.com/api/device/bind（用户名+密码 → 设备令牌），
// 再用设备令牌换中心库地址+连接码（/api/cockpit/central-config）。手机端走同一条路，
// 所以「手机上登录」和「电脑上登录」是同一个账号、同一本账，不用再手抄连接码。
const CLOUD_LOGIN = 'https://sync.junchengzn.com'
function savedAccount() { try { return localStorage.getItem('fi-account') || '' } catch (e) { return '' } }
function savedServer() { try { return localStorage.getItem('fi-server') || '' } catch (e) { return '' } }
// 这台手机到底是怎么登录进来的：走过账号密码 → 存了 fi-account；
// 只粘过连接码 → 没账号，换码就得重新粘（这也是老板老觉得"还是链接加 token"的根源）。
function loginMethod() {
  const account = savedAccount()
  let deviceToken = false
  try { deviceToken = !!localStorage.getItem('fi-device-token') } catch (e) { deviceToken = false }
  return { account, byAccount: !!account, deviceToken }
}

// 401 自救：中心库换过连接码时，用**设备令牌**去云端换当前有效的新码 —— 用户什么都不用做。
// 设备令牌（uploadToken）不像连接码那样会被轮换，所以它是"换码后还能自己恢复"的关键。
let selfHealTried = false
function refreshCentralToken() {
  let uid = '', tk = ''
  try { uid = localStorage.getItem('fi-device-userid') || ''; tk = localStorage.getItem('fi-device-token') || '' } catch (e) {}
  if (!uid || !tk) return Promise.resolve(false)
  return cfFetch(CLOUD_LOGIN + '/api/cockpit/central-config', { headers: { 'x-user-id': uid, 'x-token': tk } }, 15000)
    .then(function (r) { return r.json().catch(function () { return {} }) })
    .then(function (c) {
      if (!c || !c.ok || !c.token) return false
      let cur = ''
      try { cur = localStorage.getItem('fi-mobile-token') || '' } catch (e) {}
      if (String(c.token) === cur) return false          // 码没变 → 是别的问题，别乱动
      try {
        localStorage.setItem('fi-mobile-token', String(c.token))
        localStorage.setItem('fi-server', String(c.url || CLOUD_LOGIN))
      } catch (e) {}
      return true
    })
    .catch(function () { return false })
}

function cfFetch(url, opt, ms) {
  return new Promise(function (resolve, reject) {
    var ctrl = new AbortController()
    var t = setTimeout(function () { ctrl.abort() }, ms || 15000)
    fetch(url, Object.assign({ signal: ctrl.signal }, opt || {}))
      .then(function (r) { clearTimeout(t); resolve(r) })
      .catch(function (e) { clearTimeout(t); reject(e) })
  })
}

function openLoginPanel(firstRun, reason) {
  const old = document.getElementById('lg-panel'); if (old) old.remove()
  const ov = document.createElement('div')
  ov.id = 'lg-panel'
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.97);z-index:300;padding:22px;color:#e6edf5;overflow:auto'
  const inpCss = 'width:100%;height:58px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);border-radius:12px;color:#fff;font-size:17px;padding:0 14px;outline:none;margin-bottom:10px'
  ov.innerHTML =
    '<div style="font-size:22px;font-weight:800;margin-bottom:6px">登录店铺账本</div>' +
    (reason === 'stale'
      ? '<div style="font-size:14px;line-height:1.8;color:#ffd9a8;background:rgba(212,175,55,.14);border-radius:10px;padding:12px;margin-bottom:14px">店里换过连接码了，旧的连接码已经作废（所以刚才一直提示失效）。<br>用<b>账号密码</b>登录就行 —— 登录会自动拿到当前有效的新码。</div>'
      : reason === 'bind'
        ? '<div style="font-size:14px;line-height:1.8;color:#ffd9a8;background:rgba(212,175,55,.14);border-radius:10px;padding:12px;margin-bottom:14px">这台手机现在是<b>用连接码接入</b>的（没有走过账号密码）。<br>用账号密码登录一次，以后店里换连接码手机能自己恢复，忘了密码也能找回来。</div>'
        : reason === 'switch'
          ? '<div style="font-size:14px;color:#8fa3c0;line-height:1.75;margin-bottom:16px">换一个账号登录。当前：<b style="color:#d4af37">' + escHtml(savedAccount() || '连接码接入') + '</b></div>'
      : '<div style="font-size:14px;color:#8fa3c0;line-height:1.75;margin-bottom:16px">用电脑上那个<b style="color:#d4af37">账号 + 密码</b>登录，和桌面端同一套账号、同一本账。</div>') +
    (firstRun ? '<div style="font-size:14px;color:#8fa3c0;line-height:1.75;margin-bottom:16px">登录后开单、入库、查库存、看今天赚多少都能用。</div>' : '') +
    '<input id="lg-user" placeholder="账号" autocomplete="username" spellcheck="false" style="' + inpCss + '">' +
    '<input id="lg-pass" type="password" placeholder="密码" autocomplete="current-password" style="' + inpCss + '">' +
    '<div id="lg-msg" style="font-size:13px;color:#ffb4b4;min-height:20px;margin:2px 0 12px;line-height:1.6"></div>' +
    '<button id="lg-go" style="width:100%;height:60px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:19px;font-weight:800">登录并进入</button>' +
    '<button id="lg-forgot" style="width:100%;height:46px;margin-top:10px;border-radius:12px;border:none;background:rgba(255,255,255,.08);color:#b9c8dd;font-size:15px">忘记密码？</button>' +
    '<div style="display:flex;align-items:center;gap:10px;margin:18px 0 14px;color:#5d708c;font-size:12px"><div style="flex:1;height:1px;background:rgba(255,255,255,.15)"></div>或者<div style="flex:1;height:1px;background:rgba(255,255,255,.15)"></div></div>' +
    '<button id="lg-code" style="width:100%;height:50px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px;font-weight:700">用连接码 / 扫码接入</button>' +
    (savedServer() ? '<div style="font-size:12px;color:#8fa3c0;margin-top:12px">上次连的账本：' + escHtml(savedServer()) + '</div>' : '')
  document.body.appendChild(ov)
  const u = ov.querySelector('#lg-user'), p = ov.querySelector('#lg-pass'), msg = ov.querySelector('#lg-msg'), go = ov.querySelector('#lg-go')
  try { u.value = savedAccount() } catch (e) {}
  function say(t, color) { msg.style.color = color || '#ffb4b4'; msg.textContent = t || '' }
  function connect(payload, deviceName) {
    say('正在登录…', '#8fa3c0'); go.disabled = true
    cfFetch(CLOUD_LOGIN + '/api/device/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: payload.username, password: payload.password, deviceName: deviceName }),
    }, 20000).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (j) { return { status: r.status, j: j } })
    }).then(function (res) {
      const j = res.j || {}
      if (res.status === 429) throw new Error(j.error || '试得太多次了，过 15 分钟再试')
      if (!j.ok || !j.uploadToken) throw new Error(j.error || (res.status === 401 ? '账号或密码不对' : '登录失败（' + res.status + '）'))
      return cfFetch(CLOUD_LOGIN + '/api/cockpit/central-config', {
        headers: { 'x-user-id': String(j.userId), 'x-token': String(j.uploadToken) },
      }, 20000).then(function (r2) { return r2.json().catch(function () { return {} }) }).then(function (c) {
        if (!c || !c.ok || !c.token) throw new Error((c && c.error) || '账号没问题，但没取到账本地址，请联系维护')
        try {
          localStorage.setItem('fi-mobile-token', String(c.token))
          localStorage.setItem('fi-server', String(c.url || CLOUD_LOGIN))
          localStorage.setItem('fi-account', String(j.username || payload.username))
          // 设备令牌留着：以后店里换连接码，手机能自己换到新码，不用再找你
          localStorage.setItem('fi-device-userid', String(j.userId))
          localStorage.setItem('fi-device-token', String(j.uploadToken))
        } catch (e) {}
        say('登录成功，正在打开…', '#8ce0a8')
        setTimeout(function () { location.reload() }, 400)
      })
    }).catch(function (e) {
      go.disabled = false
      const m = String((e && e.message) || e)
      say(/abort|Failed to fetch|NetworkError|Load failed/i.test(m) ? '连不上账号服务器，检查手机网络后重试' : m)
    })
  }
  function submit() {
    const username = (u.value || '').trim(), password = p.value || ''
    if (!username) { say('请填账号'); u.focus(); return }
    if (!password) { say('请填密码'); p.focus(); return }
    const dev = '手机 ' + (navigator.userAgent.indexOf('Android') >= 0 ? '安卓' : '')
    connect({ username: username, password: password }, dev)
  }
  go.onclick = submit
  p.onkeydown = function (e) { if (e.key === 'Enter') submit() }
  u.onkeydown = function (e) { if (e.key === 'Enter') p.focus() }
  ov.querySelector('#lg-forgot').onclick = function () {
    alert('忘记密码：\n\n· 短信找回还没开通（要接短信网关，后面加）；\n· 现在请找店主，在电脑上用管理员重置密码，重置后用新密码登录。\n\n你也可以先用「连接码 / 扫码」接入。')
  }
  ov.querySelector('#lg-code').onclick = function () { ov.remove(); openConnectPanel(firstRun) }
  setTimeout(function () { (u.value ? p : u).focus() }, 150)
}

function openConnectPanel(firstRun) {
  const old = document.getElementById('cn-panel'); if (old) old.remove()
  const ov = document.createElement('div')
  ov.id = 'cn-panel'
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.97);z-index:300;padding:22px;color:#e6edf5;overflow:auto'
  ov.innerHTML =
    '<div style="font-size:22px;font-weight:800;margin-bottom:6px">账号与连接</div>' +
    '<div style="font-size:14px;color:#8fa3c0;line-height:1.75;margin-bottom:14px">当前登录方式：<b style="color:#e6edf5">' + (loginMethod().byAccount ? ('账号密码（' + escHtml(loginMethod().account) + '）') : '连接码接入（没走账号密码）') + '</b></div>' +
    (loginMethod().byAccount ? '' :
      '<div style="font-size:13px;line-height:1.7;color:#ffd9a8;background:rgba(212,175,55,.14);border-radius:10px;padding:11px;margin-bottom:12px">建议改成账号密码登录：店里换过连接码时手机能自动恢复，忘了密码也能找回。</div>' +
      '<button id="cn-acct" style="width:100%;height:56px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:17px;font-weight:800;margin-bottom:10px">用账号密码登录一次</button>') +
    '<button id="cn-adv" style="width:100%;height:46px;border-radius:12px;border:none;background:rgba(255,255,255,.08);color:#b9c8dd;font-size:14px;font-weight:700;margin-bottom:10px">高级：用连接码 / 扫码接入</button>' +
    '<div id="cn-advbox" style="display:none">' +
    '<div style="font-size:13px;color:#8fa3c0;line-height:1.7;margin-bottom:10px">把店主发给你的<b style="color:#d4af37">连接码</b>粘进来就行；整条链接（https://…）直接粘进来也能认。</div>' +
    '<input id="cn-in" placeholder="在这里粘贴连接码" autocomplete="off" spellcheck="false" style="width:100%;height:60px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);border-radius:12px;color:#fff;font-size:17px;padding:0 14px;outline:none">' +
    '<div id="cn-echo" style="font-size:13px;color:#8fa3c0;margin:8px 0 14px;min-height:18px"></div>' +
    '<div style="display:flex;gap:10px;margin-bottom:12px">' +
      '<button id="cn-paste" style="flex:1;height:52px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px;font-weight:700">粘贴</button>' +
      '<button id="cn-scan" style="flex:1;height:52px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px;font-weight:700">扫码</button>' +
    '</div>' +
    '<button id="cn-go" style="width:100%;height:56px;border-radius:14px;border:none;background:rgba(255,255,255,.92);color:#0a1628;font-size:17px;font-weight:800">用连接码连接</button>' +
    '</div>' +
    '<button id="cn-off" style="width:100%;height:50px;margin-top:12px;border-radius:12px;border:none;background:rgba(248,113,113,.18);color:#ffd9d9;font-size:15px">断开本机连接</button>' +
    '<div style="font-size:12px;color:#8fa3c0;margin-top:14px;line-height:1.8">当前：' + (TOKEN ? '已连接' : '还没连接') + '<br>连接码在店主那台电脑上，或让店主发你一条链接。' +
    (firstRun ? '<br><br>连上以后，开单、查库存、看今天赚多少都能用。' : '') + '</div>' +
    (SERVER ? '<button id="cn-up" style="width:100%;height:44px;margin-top:12px;border-radius:12px;border:none;background:rgba(255,255,255,.08);color:#b9c8dd;font-size:14px">' + FiIcon('refresh', 15) + ' 检查更新（当前 ' + APP_VERSION + '）</button>' : '')
  document.body.appendChild(ov)
  const inp = ov.querySelector('#cn-in'), echo = ov.querySelector('#cn-echo')
  function refresh() {
    const p = parseConnectInput(inp.value)
    echo.textContent = p.token
      ? ('已识别连接码：' + p.token.slice(0, 6) + '…（' + p.token.length + ' 位）' + (p.server ? ' · 地址已带上' : ''))
      : (inp.value.trim() ? '没看出连接码，检查一下是不是复制全了' : '')
  }
  function connect() {
    const p = parseConnectInput(inp.value)
    if (!p.token) { toast('先把连接码粘进来'); inp.focus(); return }
    if (p.token.length < 8) { toast('连接码太短，可能没复制全（一般是 32 位）'); return }
    try {
      localStorage.setItem('fi-mobile-token', p.token)
      if (p.server) localStorage.setItem('fi-server', p.server)
    } catch (e) {}
    toast('连接成功，正在打开…')
    setTimeout(function () { location.reload() }, 500)
  }
  inp.oninput = refresh
  ov.querySelector('#cn-paste').onclick = async function () {
    try {
      const t = await navigator.clipboard.readText()
      if (t) { inp.value = t; refresh(); if (parseConnectInput(t).token) connect() } else { toast('剪贴板是空的，长按输入框粘贴') }
    } catch (e) { toast('长按输入框，手动粘贴'); inp.focus() }
  }
  ov.querySelector('#cn-scan').onclick = function () {
    openScanner(function (code) { if (code) { inp.value = code; refresh() } }, '扫描店主给的二维码')
  }
  ov.querySelector('#cn-go').onclick = connect
  const acctBtn = ov.querySelector('#cn-acct')
  if (acctBtn) acctBtn.onclick = function () { ov.remove(); openLoginPanel(false, 'bind') }
  ov.querySelector('#cn-adv').onclick = function () {
    const box = ov.querySelector('#cn-advbox')
    const open = box.style.display === 'none'
    box.style.display = open ? 'block' : 'none'
    ov.querySelector('#cn-adv').textContent = open ? '收起连接码输入' : '高级：用连接码 / 扫码接入'
    if (open) { const i = ov.querySelector('#cn-in'); if (i) i.focus() }
  }
  const upBtn = ov.querySelector('#cn-up')   // 还没连上时的更新入口（1.1.2 起；浏览器页面没有这个按钮）
  if (upBtn) upBtn.onclick = function () { checkAllUpdates(false) }
  ov.querySelector('#cn-off').onclick = function () {
    try { localStorage.removeItem('fi-mobile-token'); localStorage.removeItem('fi-server') } catch (e) {}
    toast('已断开，重开 APP 再连一次')
    setTimeout(function () { location.reload() }, 600)
  }
  refresh()
  setTimeout(function () { inp.focus() }, 150)
}
// 断网自动提示 + 恢复自动隐藏（T4）
window.addEventListener('resize', function () { applyViewportHeight() })
try { if (window.visualViewport) window.visualViewport.addEventListener('resize', function () { applyViewportHeight() }) } catch (e) {}
window.addEventListener('offline', () => showNetBanner('网络已断开，请检查手机网络', '#ffe9d6', () => { hideNetBanner(); renderPage(true) }))
window.addEventListener('online', () => { hideNetBanner(); flushOffline(); renderPage(true) })

let currentPage = ''
let renderGen = 0 // 页面代次：切页后旧请求的续写一律丢弃，避免把上一页的数据写进新页面
function navigate(hash) { location.hash = hash }
window.addEventListener('hashchange', () => renderPage())
document.addEventListener('DOMContentLoaded', () => {
  // ⓪ 顶部安全区：先把状态栏那一段垫出来，再渲染页面（否则第一帧标题会被盖住）
  initSafeArea()
  // ① 网页层热更：报心跳 + 顺手查新版（只对装了 APP 的机器生效；不依赖是否已连店铺）
  // 反馈闭环：开机拉一次「我的反馈」，有回复就在「更多」上显示红点
  setTimeout(function () { fiLoadMyFeedback() }, 2500)
  const wuState = initWebUpdate()
  // ①b 更新说明：热更自动做完后，弹一次「已更新到 X + 这次改了什么」——
  // 老板要的「有更新要提示、还要说清优化了什么」，就落在这里。
  if (wuState && wuState.then) wuState.then(afterWebUpdate).catch(function () {}); else setTimeout(afterWebUpdate, 800)
  // ② 原生壳检查（只有壳变了才有内容），同样不依赖「是否已连上」
  setTimeout(function () { checkUpdate(true) }, 3000)
  // 没有连接码：用页内面板（可粘整条链接 / 扫码），不再用系统弹窗 —— 店主不会打长串；
  // 官网 / 局域网 /m/ 也一样走这里（粘连接码即可，SERVER 留空=同源）。
  if (!TOKEN) { openLoginPanel(true); return }   // 没登录：先给账号密码登录（连接码/扫码在面板里作为备选）
  document.getElementById('dateEl').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  renderPage()
  flushOffline() // 开机先把上次离线攒下的单据重传一遍
  // 上报一次「这台设备在用」（只发安装号+版本，不带经营数据）。
  // 等热更状态读出来再报，这样服务端能看到每台手机真正跑着的网页层版本；插件卡住也有 1.5 秒兜底，绝不漏报。
  let pingSent = false
  const pingOnce = function () { if (!pingSent) { pingSent = true; appPing() } }
  if (wuState && wuState.then) { wuState.then(pingOnce).catch(pingOnce); setTimeout(pingOnce, 1500) } else pingOnce()
  // 首次使用引导：第一次打开自动弹（看过一次就不再打扰，更多页可重看）
  try { if (!localStorage.getItem('fi-guided')) setTimeout(function () { openGuide(false) }, 1200) } catch (e) {}
  // 首次连上后问一次「这台手机谁在用」；不选就一直用「老板」，不再打扰
  try { if (!localStorage.getItem('fi-operator')) setTimeout(openOperatorPanel, 700) } catch (e) {}
})

function renderPage(force) {
  const hash = (location.hash || '#pos').replace('#', '')
  const page = hash || 'pos'
  if (page === currentPage && !force) return
  currentPage = page
  renderGen++
  document.querySelectorAll('.tab').forEach(a => {
    a.classList.toggle('on', a.getAttribute('href') === '#' + page)
  })
  const app = document.getElementById('app')
  app.classList.remove('absorb')   // 只有开单页要三区固定，别的页恢复正常滚动
  app.classList.remove('fill')     // 入库页会让「待补货」吃掉剩余高度；换页要还原
  renderAccountChip()              // 右上角账号一直挂着（账号/登录方式变了要跟着变）
  app.innerHTML = '<div class="text-center" style="padding:40px;color:var(--sub)">加载中...</div>'
  const fn = pages[page]
  if (fn) { try { fn(app) } catch (e) { app.innerHTML = '<div class="text-center" style="padding:40px"><div style="font-size:48px">' + FiIcon('alert', 15) + '</div><div class="text-red font-bold mt">' + page + ' 出错</div><div class="text-sm text-muted mt-sm">' + e.message + '</div></div>' } }
  else if (LAZY_PAGES[page]) {
    // 低频页：首次进入时才去取脚本；离线且缓存里还没有 → 明确告知，不假装加载中
    loadPageScript(page).then(function (ok) {
      if (currentPage !== page) return
      const f2 = pages[page]
      if (f2) { try { app.innerHTML = ''; f2(app) } catch (e) { app.innerHTML = '<div class="text-center" style="padding:40px"><div class="text-red font-bold mt">' + page + ' 出错</div><div class="text-sm text-muted mt-sm">' + e.message + '</div></div>' } }
      else { app.innerHTML = '<div class="text-center" style="padding:40px"><div class="font-bold mt">这一页还没下载好</div><div class="text-sm text-muted mt-sm">连一次网打开它，之后离线也能用</div></div>' }
    })
  }
  else { app.innerHTML = '<div class="text-center" style="padding:40px"><div style="font-size:48px">' + FiIcon('alert', 15) + '</div><div class="font-bold mt">页面未找到</div></div>' }
}

// ========== 印章动画 ==========
function showStamp(text, detail, isGreen) {
  const el = document.getElementById('doneStamp'), sa = document.getElementById('stampA'), sb = document.getElementById('stampB'), se = document.getElementById('stampEl')
  sa.textContent = text
  sb.textContent = detail || ''
  se.classList.toggle('green', !!isGreen)
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 1300)
}

// ========== Toast ==========
let tt
function toast(msg) {
  const el = document.getElementById('toastEl')
  el.textContent = msg; el.classList.add('show')
  clearTimeout(tt); tt = setTimeout(() => el.classList.remove('show'), 1500)
}

// ========== 工具 ==========
function fmt(cents, nullText) {
  if (cents === null || cents === undefined) return nullText || '-'
  const v = cents / 100
  return '¥' + (v % 1 ? v.toFixed(2) : v.toFixed(0))
}

// 服务端时间戳是 **UTC ISO**（形如 2026-09-21T08:31:54.762Z）。
// 以前各页直接 slice(11,16) 取字符串 —— 那是把 UTC 当成本地时间显示，北京时间会差 8 小时
// （16:31 卖的单子显示成 08:31，老板看到的就是"卖出去货物的时间对不上"）。
// 统一走这两个函数：先 new Date() 让浏览器按本机时区换算，再取时分。
function fiHHMM(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return String(ts).slice(11, 16)   // 不是标准时间格式（如老数据）→ 退回原样截取
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
}
// 时间戳 → 本机小时（0-23）；解析不了返回 NaN（调用方据此跳过，不要算进 0 点）
function fiHour(ts) {
  if (!ts) return NaN
  const d = new Date(ts)
  return isNaN(d.getTime()) ? NaN : d.getHours()
}
// 今天（本机时区）的 YYYY-MM-DD。不能用 new Date().toISOString().slice(0,10) ——
// 那是 UTC 日期：北京时间 00:00~08:00 会算成前一天，AI 日报/对账的日期就串了一天。
function fiLocalDate(d) {
  const x = d ? new Date(d) : new Date()
  const pad = function (n) { return n < 10 ? '0' + n : '' + n }
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate())
}
// ========== 分类 / 单位下拉（入库、建档页共用）==========
// 老板 2026-09-21 反馈：「商品的分类里没有分类，只有一个其他分类」「计量单位太少了，
// 饵料是包、蚯蚓是千克、铅是个、鱼竿是根」。根因：入库页那句动态拉分类的 invoke(...) 调的是
// 不存在的函数（app.js 只有 api / invokeRaw），ReferenceError 被 try/catch 吞掉，所以下拉里
// 永远只有写死的「其他」和「件/米」。这里统一成：**先填兜底清单 → 再拉服务端真清单覆盖**。
function fiEscOpt(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] }) }

// ========== 规格（同一个商品的不同型号/线号/长度）==========
// 老板 2026-09-21：「库存如何在商品的基础上加规格？规格如何加数量？总数量是总数量，
// 单一规格数量是单一规格的数量……开单时如何选规格？如何高效又方便？」
//
// 现状（查过真库）：商品表**早就有** sub_category 列，老板一直用它记规格
// （例：品牌「东哥」+ 型号「东哥线」+ 规格「3.9m-1.5#」），parent_id 列存在但从没用过。
// 也就是说：**数据模型本来就是一商品多规格**，缺的只是「把它们当一个商品看」的那层界面。
// 所以这里不新增表、不迁移数据，按「品牌+型号」把同族商品聚起来，sub_category 当规格名。
function fiSpecKey(p) { return (String(p.brand || '').trim() || '(无牌)') + '|' + String(p.model || '').trim() }
function fiSpecName(p) { return String(p.sub_category || '').trim() }
function fiSpecProductName(p) { return ((String(p.brand || '').trim() + ' ' + String(p.model || '').trim()).trim()) || p.sku_code || '商品' }
/** 同族商品（同一个品牌+型号）。只有 ≥2 条、且至少有一条写了规格名，才当成「一商品多规格」；
 *  否则可能只是重复档案（库里确实有同名重复），合并显示反而误导。 */
function fiSpecFamily(p, all) {
  const key = fiSpecKey(p)
  const fam = (all || []).filter(function (x) { return fiSpecKey(x) === key })
  if (fam.length < 2) return [fam[0] || p]
  if (!fam.some(fiSpecName)) return [fam[0] || p]
  return fam.slice().sort(function (a, b) { return fiSpecName(a).localeCompare(fiSpecName(b), 'zh') })
}
/** 一个「商品」的总数量 = 各规格数量之和（老板明确要的口径） */
function fiSpecTotalStock(fam) { return (fam || []).reduce(function (s, x) { return s + (Number(x.total_stock) || 0) }, 0) }

// 保质期商品品类：饵料/小药/活饵/路亚假饵（与电脑端 requiresExpiry 同口径）
const EXPIRY_REQUIRED_CATEGORIES = ['饵料', '小药', '活饵', '路亚假饵']

// 保质期默认值（老板 2026-09-21）：
//   「正常的饵料保质期是两年，其他的标品基本没有所谓的保质期；
//     应该从建档日期往后两年去推，而不是自己手动去填保质期。」
// 所以：需要保质期的品类 → 到期日自动填「今天 + 2 年」（可改）；标品留空。
// 建档日就是今天（拍照/扫码的当下），直接按今天推两年。
const EXPIRY_DEFAULT_YEARS = 2
function defaultExpiryDate(cat) {
  if (EXPIRY_REQUIRED_CATEGORIES.indexOf(cat) < 0) return ''
  const d = new Date()
  d.setFullYear(d.getFullYear() + EXPIRY_DEFAULT_YEARS)
  const pad = function (n) { return n < 10 ? '0' + n : '' + n }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

// 品类变了就顺手把到期日填成默认值（用户已经改过的不覆盖）。挂在 app.js 便于复用与测试。
function fillExpiryDefault(cat) {
  const el = document.getElementById('f-expiry')
  if (!el) return
  const def = defaultExpiryDate(cat)
  if (def && !el.value) el.value = def
}

// AI 识别失败时该说哪句话。三种情况必须分开 —— 老板 2026-09-21 就是被混淆的那个：
// 当天额度用完（20 次）也被说成「AI 没认出商品」，他于是以为识别功能坏了。
function fiAiFailMessage(r) {
  const why = (r && r.reason) ? String(r.reason) : ''
  if (r && (r.code === 'quota-exceeded' || /额度|次数已用完/.test(why))) {
    return (why || '今天的 AI 识别次数用完了') + '  照片已经挂上了，手填一下名称即可'
  }
  if (/no-key-or-image|no-vision|no-key|ai-not-ready/i.test(why)) return '这台机器没配 AI，手填就好（照片已挂上）'
  return 'AI 没认出商品，手填就好（照片已挂上）'
}

// 把 AI/后端给的分类名归一成**下拉里真实存在的那个名字**。
// 为什么需要：给模型看的分类清单带了大分类前缀（「线组钩漂 > 鱼钩」方便它辨别），
// 而下拉的 <option> 只有叶子名（「鱼钩」）；直接 setValue("线组钩漂 > 鱼钩") 匹配不到任何一项，
// 下拉会静默落回第一项 —— 老板看到的就是「自动分类没生效」。
function fiNormalizeCategory(raw, sel) {
  const s0 = String(raw == null ? '' : raw).trim()
  if (!s0) return ''
  const leaf = s0.indexOf('>') >= 0 ? s0.split('>').pop().trim() : s0
  const opts = (sel && sel.options) ? Array.from(sel.options).map(function (o) { return o.value || o.textContent }) : []
  if (!opts.length) return leaf
  if (opts.indexOf(leaf) >= 0) return leaf
  // 再退一步：模糊匹配（模型可能多写/少写一两个字）
  const hit = opts.find(function (o) { return o && (o.indexOf(leaf) >= 0 || leaf.indexOf(o) >= 0) })
  return hit || ''
}

// 分类：按「大分类」分组（与服务端 categories.parent 同口径），选起来比一条长列表快得多
function fiFillCategories(sel, cats, fallback) {
  if (!sel) return
  // 记住当前选中的分类：分类清单是异步拉回来的，**重建 innerHTML 会把已经填好的值冲掉**，
  // 表现就是「AI 刚分类好、转个身又变回第一项」。填完再按名字恢复。
  const keep = String(sel.value || '')
  const rows = (Array.isArray(cats) && cats.length) ? cats : (fallback || []).map(function (n) { return { name: n, parent: null } })
  const groups = []
  const idx = {}
  for (const c of rows) {
    const p = c.parent || ''
    if (idx[p] === undefined) { idx[p] = groups.length; groups.push({ parent: p, items: [] }) }
    groups[idx[p]].items.push(c.name)
  }
  sel.innerHTML = groups.map(function (g) {
    const opts = g.items.map(function (n) { return '<option>' + fiEscOpt(n) + '</option>' }).join('')
    return g.parent ? ('<optgroup label="' + fiEscOpt(g.parent) + '">' + opts + '</optgroup>') : opts
  }).join('')
  // 把之前选中的那一项恢复回来（重建下拉会把值冲掉；还在清单里才恢复）
  if (keep) {
    const has = Array.from(sel.options).some(function (o) { return (o.value || o.textContent) === keep })
    if (has) sel.value = keep
  }
}

// 单位：option 上带 data-decimal，数量输入框据此决定整数步进还是 0.1 步进
function fiFillUnits(sel, units, fallback) {
  if (!sel) return
  const rows = (Array.isArray(units) && units.length) ? units : (fallback || []).map(function (u) { return { name: u[0], allow_decimal: u[1] } })
  sel.innerHTML = rows.map(function (u) {
    const dec = u.allow_decimal ? '1' : '0'
    return '<option value="' + fiEscOpt(u.name) + '" data-decimal="' + dec + '">' + fiEscOpt(u.name) + (dec === '1' ? '（可小数）' : '') + '</option>'
  }).join('')
}

// 当前选中的单位是否允许小数（老数据/没带标记时按整数处理，绝不让 0.5 件悄悄变成 0）
function fiUnitAllowsDecimal(sel) {
  // 不用 selectedOptions：程序化改 select.value 后它不一定立刻同步（happy-dom 实测不同步，
  // 真机 WebView 上也别赌），直接按 value 去 options 里找那一条最稳。
  if (!sel) return false
  try {
    const v = sel.value
    const list = sel.options || []
    for (let i = 0; i < list.length; i++) {
      if (list[i].value === v) return !!(list[i].dataset && list[i].dataset.decimal === '1')
    }
    return false
  } catch (e) { return false }
}

// 把「米/斤/公斤/千克/克/卷」这些能拆着卖的单位按 0.1 步进，其余按整数 —— 与服务端 units.allow_decimal 同口径
function fiRoundQty(v, allowDecimal) {
  const n = parseFloat(v)
  if (!isFinite(n)) return 0
  return allowDecimal ? Math.round(n * 10) / 10 : Math.floor(n)
}

// 商品缩略底色：**统一**白蓝渐变（老板说"颜色太花了"）。
// 原来按商品 id 在 9 色里取一个，一屏十几张卡五颜六色；现在只有一种蓝，靠首字和名称区分。
function phColor() { return 'linear-gradient(135deg,#60a5fa,#2563eb)' }
function phChar(p) { const name = (((p.brand || '') + ' ' + (p.model || '')).trim() || p.sku_code || ''); return name[0] || '?' }
function prodName(p) { const n = ((p.brand || '') + ' ' + (p.model || '')).trim(); return (n || p.sku_code || '未知') }

// ========== 界面字号（小 / 标准 / 大）==========
// 手机屏小，一套尺寸放大就显得挤。整套界面尺寸都跟着 index.html 里的 --s 一个比例走，
// 这里只负责记档位 + 给 body 挂 class —— 切完立刻生效，不用重开。
const UI_SIZES = ['s', 'm', 'l']
function savedUiSize() { try { const v = localStorage.getItem('fi-ui-size'); return UI_SIZES.indexOf(v) >= 0 ? v : 'm' } catch (e) { return 'm' } }
function applyUiSize(v) {
  const s = UI_SIZES.indexOf(v) >= 0 ? v : 'm'
  try { localStorage.setItem('fi-ui-size', s) } catch (e) {}
  try {
    document.body.classList.remove('size-s', 'size-m', 'size-l')
    document.body.classList.add('size-' + s)
  } catch (e) {}
  return s
}
applyUiSize(savedUiSize())

// ========== 首次使用引导（五步）==========
// 老板要的"首次下载要加入引导使用"：第一次打开自动弹一次，之后可以在「更多 → 使用引导」重看。
function openGuide(manual) {
  const steps = [
    { icon: 'cart', t: '第 1 步 · 开单卖货', d: '点分类找货，或搜一个字、或扫码 → 点商品加进下面的「购物清单」→ 点 现金/微信/支付宝/赊账 中的一个就记账了（点「合计」上方的提示也能看到这句话）。' },
    { icon: 'clipboard', t: '第 2 步 · 进货入库', d: '「入库」页四个入口：AI 拍照建档、手动建档、扫码入库、拍整张进货单一次入完。新建的货会立刻出现在下面的「今日入库」里。' },
    { icon: 'box', t: '第 3 步 · 看库存', d: '「库存」页先列品牌（多少种规格、库存多少、均价、几个缺货）。点品牌进去看规格明细：几米的竿、有没有货。' },
    { icon: 'chart', t: '第 4 步 · 看今天赚多少', d: '「今日」页最上面钉着 营业额/毛利/净利，下面有数据分析图（收款方式、各时段）和运营额度（应收、库存告急、支出、AI 状态）。' },
    { icon: 'sparkle', t: '第 5 步 · 有事问小渔', d: '「更多 → AI 助手」直接问："哪些货该补了"、"什么卖得最好"、"这个月赚多少"。' },
    { icon: 'type', t: '顺手调一下', d: '「更多 → 界面字号」有 小/标准/大；「更多 → 使用引导」随时能再看这个教程。' },
  ]
  let i = 0
  const ov = sheet('怎么用「AI 智能进销存」', '<div id="gd-body"></div>')
  const body = ov.querySelector('#gd-body')
  function draw() {
    const s = steps[i]
    body.innerHTML =
      '<div class="flex" style="align-items:center;gap:11px;margin-bottom:12px">' +
        '<div style="width:42px;height:42px;border-radius:13px;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;flex:none">' + FiIcon(s.icon, 22) + '</div>' +
        '<div><div class="font-bold" style="font-size:16px">' + escHtml(s.t) + '</div>' +
        '<div class="text-xs text-muted" style="margin-top:2px">第 ' + (i + 1) + ' / ' + steps.length + ' 步</div></div>' +
      '</div>' +
      '<div class="text-sm" style="line-height:1.85;color:var(--ink2)">' + escHtml(s.d) + '</div>' +
      '<div class="gdots">' + steps.map(function (_x, k) { return '<i class="' + (k === i ? 'on' : '') + '"></i>' }).join('') + '</div>' +
      '<div class="flex" style="gap:9px;margin-top:14px">' +
        (i > 0 ? '<button id="gd-prev" style="flex:1;height:46px;border-radius:12px;border:1px solid var(--line);background:var(--card2);font-size:15px;font-weight:800;color:var(--ink)">上一步</button>' : '') +
        '<button id="gd-next" class="okbtn" style="flex:2;height:46px">' + (i === steps.length - 1 ? '开始使用' : '下一步') + '</button>' +
      '</div>' +
      '<button id="gd-skip" style="width:100%;height:42px;margin-top:9px;border-radius:12px;border:none;background:transparent;color:var(--sub);font-size:13px">' + (manual ? '关闭' : '跳过，我直接开始用') + '</button>'
    const prev = body.querySelector('#gd-prev'); if (prev) prev.onclick = function () { i--; draw() }
    body.querySelector('#gd-next').onclick = function () {
      if (i === steps.length - 1) { finish() } else { i++; draw() }
    }
    body.querySelector('#gd-skip').onclick = finish
  }
  function finish() {
    try { localStorage.setItem('fi-guided', '1') } catch (e) {}
    ov.remove()
  }
  draw()
}

// ========== 更新：分两层，各管各的 ==========
// 第 1 层（主力）网页层热更新：这套 APP 的原生部分只有一层薄壳（WebView + 安装器），
//   业务代码 100% 是网页（app.js / pages/*.js / index.html / offline.js / sw.js）。
//   所以绝大多数改动（页面、逻辑、文案、样式）根本不用重装 APK ——
//   原生插件 WebUpdater 拉清单比对 sha256，**只下载改动的那几个文件**，校验后直接换资源目录并重载。
//   实测：改一个页面 ≈ 几 KB~几十 KB，秒级生效，没有安装界面、没有"允许安装未知来源"。
// 第 2 层（兜底）原生壳更新：只有壳本身变了（权限、插件、图标、包名、TargetSdk）才需要重新装 APK，
//   也就是下面这套「下载安装包 → 拉起系统安装器」。
// 版本号必须与 android/app/build.gradle 的 versionCode/versionName 一致 ——
// 有 scripts/check-version-sync.mjs 强制校验，发版前必跑（否则会重演「版本号三处不一致、更新永远是哑的」）。
const APP_VERSION = 'v1.3.0'
const APP_VERSION_CODE = 1106
const UPDATE_BASE = 'http://43.128.20.39:17533'
const WEB_MANIFEST = 'https://junchengzn.com/download/web/manifest.json'   // 网页层清单（HTTPS 静态）
let WEB_VERSION_APPLIED = ''   // 当前真正跑着的网页层版本（热更后会与 APP_VERSION 不同）
let WEB_USING_BUNDLE = false   // true = 现在跑的是热更包（不是安装包自带素材）
let WEB_JUST_UPDATED = ''      // 上一次启动刚热更到的版本（原生插件记的），用来弹「已更新到 X」

/** 取原生热更插件（只装了 APP 才有；浏览器 / 局域网 /m/ 没有这层） */
function webUpdaterPlugin() {
  try { return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.WebUpdater) || null } catch (e) { return null }
}

// 开机三件事：① 报心跳（告诉原生「这一版网页跑得起来，别回退」）
//            ② 读当前生效的热更版本 ③ 2.5 秒后顺手查有没有新版
// 返回一个 promise：原生插件读完「当前跑的是哪一版网页」就 resolve。
// 心跳必须等它 —— 否则上报的 webVersion 永远是空的（2026-09-21 实测服务端 app_installs 全是空，
// 根本看不出哪台手机跑的是哪一版，排查「老板说没生效」时抓瞎）。
function initWebUpdate() {
  const WU = webUpdaterPlugin()
  if (!WU) return null
  let statePromise = null
  // 顺序要紧：先读状态（拿「上次刚热更到哪一版」，好告诉用户一声），再报心跳（心跳会把这条提醒清掉）
  try {
    statePromise = WU.getState().then(function (s) {
      WEB_USING_BUNDLE = !!(s && s.usingBundle)
      if (s && s.usingBundle && s.version) WEB_VERSION_APPLIED = s.version
      // 跑的是安装包自带素材时，也要知道「当前是内置的哪一版」——
      // 否则第一次热更上来时没有基准，会误判成「首次安装」而错过更新提示。
      else if (s && s.builtinVersion) WEB_VERSION_APPLIED = s.builtinVersion
      // 上一轮刚热更完：原生插件记住了版本号。这里不要只用一句 toast 打发，
      // 老板明确要求「更新优化了什么、更新说明要提出来」—— 记下来，等会弹说明面板。
      if (s && s.justUpdated) WEB_JUST_UPDATED = s.justUpdated
      return WU.markHealthy()
    }).catch(function () {})
  } catch (e) { statePromise = Promise.resolve() }
  setTimeout(function () {
    try {
      // 有新版就自动换：插件内部会切资源目录并重载（所以这里的回调常常来不及跑到，属正常）
      WU.sync({ manifestUrl: WEB_MANIFEST }).catch(function () {})
    } catch (e) {}
  }, 2500)
  return statePromise
}

/** 手动「检查更新」：先热更（局部），没有网页层更新再查原生壳 */
function checkAllUpdates(silent) {
  const WU = webUpdaterPlugin()
  if (!WU) { checkUpdate(silent); return }
  if (!silent) toast('正在检查更新…')
  WU.sync({ manifestUrl: WEB_MANIFEST }).then(function (r) {
    if (r && r.updated) { toast('网页层更新到 ' + r.version + '（' + (r.downloaded | 0) + ' 个文件）'); return }
    fetchUpdateManifest().then(function (m) {
      if (!m) { if (!silent) toast('网页层已是最新；原生壳没连上更新服务器'); return }
      if (m.versionCode > APP_VERSION_CODE) askUpdate(m)
      else if (!silent) toast('已是最新版（网页层 ' + (WEB_VERSION_APPLIED || APP_VERSION) + '）')
    })
  }).catch(function () { checkUpdate(silent) })
}

// ========== 第 2 层：原生壳更新（只有壳变了才用；浏览器 /m/ 页面不弹）==========

// 拉更新清单：8 秒超时、不走缓存；任何异常都当作「连不上」，绝不阻塞使用
function fetchUpdateManifest() {
  return new Promise(function (resolve) {
    var ctrl = new AbortController()
    var t = setTimeout(function () { ctrl.abort() }, 8000)
    fetch(UPDATE_BASE + '/update/version.json', { signal: ctrl.signal, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) { clearTimeout(t); resolve(d && typeof d.versionCode === "number" ? d : null) })
      .catch(function () { clearTimeout(t); resolve(null) })
  })
}

// 下载走原生通道：MainActivity 收到 adingupdate:// 后下载并拉起安装
function doDownloadUpdate(meta) {
  var url = meta && meta.apkUrl
  if (!url) { toast('更新地址缺失'); return }
  toast('开始下载，稍后弹出安装界面…')
  location.href = 'adingupdate://download?url=' + encodeURIComponent(url)
}

function askUpdate(meta) {
  var old = document.getElementById("up-panel"); if (old) old.remove()
  var ov = document.createElement("div")
  ov.id = "up-panel"
  ov.style.cssText = "position:fixed;inset:0;background:rgba(10,22,40,.96);z-index:320;padding:22px;color:#e6edf5;overflow:auto"
  var h = '<div style="font-size:22px;font-weight:800;margin-bottom:6px">发现新版本 ' + escHtml(meta.versionName || "") + '</div>' +
    '<div style="font-size:13px;color:#8fa3c0;margin-bottom:14px">当前原生壳 ' + escHtml(APP_VERSION) + '</div>' +
    '<div style="font-size:12px;color:#8fa3c0;margin-bottom:14px">这一次动到了原生壳（权限/插件/图标这类），所以要重装一次；平时改页面只会自动热更，不用装。</div>'
  if (meta.changelog) h += '<div style="font-size:14px;line-height:1.8;color:#c7d2e0;background:rgba(255,255,255,.06);border-radius:10px;padding:12px;margin-bottom:14px">' + escHtml(meta.changelog) + '</div>'
  h += '<button id="up-go" style="width:100%;height:60px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:19px;font-weight:800">下载更新</button>' +
    '<button id="up-no" style="width:100%;height:50px;margin-top:10px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px">稍后再说</button>'
  ov.innerHTML = h
  document.body.appendChild(ov)
  ov.querySelector("#up-go").onclick = function () { ov.remove(); doDownloadUpdate(meta) }
  ov.querySelector("#up-no").onclick = function () { ov.remove() }
}

// 原生壳检查（第 2 层）：silent=false 时会给出反馈。只比原生壳版本，与网页层热更互不干扰。
function checkUpdate(silent) {
  if (!SERVER) return            // 浏览器/局域网页面没有安装包可更新
  if (!silent) toast("正在检查…")
  fetchUpdateManifest().then(function (m) {
    if (!m) { if (!silent) toast("连不上更新服务器，请稍后再试"); return }
    if (m.versionCode > APP_VERSION_CODE) askUpdate(m)
    else if (!silent) toast("已是最新版 " + APP_VERSION)
  })
}
// ========== 埋点与反馈（2026-09-21 反馈闭环）==========
// 目的：在这之前，「用户用了、卡在哪一步、报了什么错」我们完全看不见 ——
// 只能靠用户描述或者翻数据库猜。这一层让现场第一次可观测。
//
// 🔒 隐私边界（和网关服务端同一条，两边都挡）：
//   只上报：动作名 / 成功失败 / 耗时 / 页面 / 安装号 / 版本 / 报错摘要
//   绝不上报：金额、客户姓名、商品名、库存数 —— 任何经营数据
//   所以这里的所有调用点都只传「做了什么、成没成、花了多久」。
const FI_TELEMETRY_API = 'http://43.128.20.39:17533'   // 官方网关。只发这些统计，不走账本、不带业务数据
const FI_ERR_KEY = 'fi-recent-errors'
let fiTrackBuf = []
let fiTrackTimer = null

/** 安装号（只标识"同一台设备"，不含任何个人信息） */
function fiInstallId() {
  try {
    let v = localStorage.getItem('fi-install-id')
    if (!v) {
      v = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
      localStorage.setItem('fi-install-id', v)
    }
    return v
  } catch (e) { return '' }
}

/** 记一条动作。action 用「模块:动作」命名，便于在看板上按步骤看漏斗 */
function fiTrack(action, ok, ms) {
  try {
    fiTrackBuf.push({ a: String(action || '').slice(0, 40), ok: ok !== false, ms: Math.max(0, Math.round(Number(ms) || 0)) })
    if (fiTrackBuf.length >= 8) fiTrackFlush()
    else if (!fiTrackTimer) fiTrackTimer = setTimeout(fiTrackFlush, 8000)
  } catch (e) { /* 埋点永远不能影响主流程 */ }
}

function fiTrackFlush() {
  try {
    if (fiTrackTimer) { clearTimeout(fiTrackTimer); fiTrackTimer = null }
    if (!fiTrackBuf.length) return
    const events = fiTrackBuf.slice(0, 50)
    fiTrackBuf = []
    // keepalive：切后台/关页面时才发得出去
    fetch(FI_TELEMETRY_API + '/api/v1/app/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId: fiInstallId(), events }),
      keepalive: true,
    }).catch(function () { /* 上报失败不重试、不打扰 */ })
  } catch (e) { /* 同上 */ }
}
try { document.addEventListener('visibilitychange', function () { if (document.hidden) fiTrackFlush() }) } catch (e) {}
try { window.addEventListener('pagehide', fiTrackFlush) } catch (e) {}

/** 最近几条报错（只留摘要，给反馈带现场用） */
function fiRecordError(msg) {
  try {
    const list = JSON.parse(localStorage.getItem(FI_ERR_KEY) || '[]')
    list.unshift(String(msg || '').slice(0, 300))
    localStorage.setItem(FI_ERR_KEY, JSON.stringify(list.slice(0, 5)))
  } catch (e) { /* 忽略 */ }
}
function fiRecentErrors() {
  try { const v = JSON.parse(localStorage.getItem(FI_ERR_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch (e) { return [] }
}
try {
  window.addEventListener('error', function (e) {
    fiRecordError((e && e.message ? e.message : 'error') + ' @' + String((e && e.filename) || '').slice(-40) + ':' + ((e && e.lineno) || ''))
    fiTrack('js:error', false, 0)
  })
  window.addEventListener('unhandledrejection', function (e) {
    fiRecordError('promise: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || '').slice(0, 200))
    fiTrack('js:promise', false, 0)
  })
} catch (e) { /* 忽略 */ }

/** 反馈面板：一句话 + 自动带上现场（页面/版本/最近报错/待上传单数）。
 *  老板 2026-09-21 之前完全没有反馈通道，用户只能微信找他 —— 卡在哪、哪一版坏，全是空白。 */
function openFeedbackSheet() {
  const page = (location.hash || '#pos').replace('#', '')
  const errs = fiRecentErrors()
  const pending = (function () { try { return Offline.pendingCount() } catch (e) { return 0 } })()
  const ov = sheet('反馈给开发',
    '<div class="text-sm text-muted" style="margin-bottom:6px;line-height:1.75">哪里不对、想加什么，直接写一句就行。<br>会自动带上：当前页面、版本、最近报错 —— <b>不会带任何账目、客户、商品信息</b>。</div>' +
    '<div class="text-xs" style="margin-bottom:10px"><a href="#ai" style="color:var(--blue);font-weight:700;text-decoration:none">想先问一句？点这里找小渔 ›</a></div>' +
    '<textarea id="fb-text" rows="4" placeholder="例：改数量点了没反应 / 想加个打印小票" style="width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:12px;padding:12px;font-size:15px;font-family:inherit;background:var(--card2);color:var(--ink);outline:none"></textarea>' +
    '<input id="fb-contact" placeholder="怎么联系你？（可不填）" style="width:100%;box-sizing:border-box;margin-top:8px;height:46px;border:1px solid var(--line);border-radius:12px;padding:0 12px;font-size:15px;background:var(--card2);color:var(--ink);outline:none">' +
    '<div class="text-xs text-muted" style="margin-top:10px;line-height:1.8">将附带：页面 <b>' + escHtml(page) + '</b> · 网页层 <b>' + escHtml(WEB_VERSION_APPLIED || APP_VERSION) + '</b> · 壳 <b>' + escHtml(APP_VERSION) + '</b>' + (pending ? ' · 待上传 <b>' + pending + '</b> 单' : '') + (errs.length ? '<br>最近报错 ' + errs.length + ' 条' : '') + '</div>' +
    '<button id="fb-send" style="width:100%;height:54px;margin-top:14px;border-radius:14px;border:none;background:var(--blue);color:#fff;font-size:17px;font-weight:800">发送</button>')
  const btn = ov.querySelector('#fb-send')
  btn.onclick = function () {
    const text = String((ov.querySelector('#fb-text') || {}).value || '').trim()
    if (!text) { toast('写一句话再发'); return }
    btn.disabled = true; btn.textContent = '正在发送…'
    fetch(FI_TELEMETRY_API + '/api/v1/app/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installId: fiInstallId(), text: text, contact: String((ov.querySelector('#fb-contact') || {}).value || '').trim(),
        page: page, webVersion: WEB_VERSION_APPLIED || '', version: APP_VERSION,
        platform: (function () { try { return (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web' } catch (e) { return 'web' } })(),
        device: (function () { try { return (navigator.userAgent || '').slice(-60) } catch (e) { return '' } })(),
        errors: errs, pendingWrites: pending,
      }),
    }).then(function (r) { return r.ok }).catch(function () { return false }).then(function (okd) {
      ov.remove()
      if (okd) { toast('收到了，谢谢！我们会看'); fiTrack('feedback:sent', true, 0) }
      else { toast('没发出去，检查网络后再试（也可以直接微信找我们）'); fiTrack('feedback:sent', false, 0) }
    })
  }
}

/** 每日提醒设置：老板自己填机器人地址（企业微信 / 飞书群机器人），每天定时推「今天该做的事」。
 *  为什么走机器人而不是 APP 推送：微信他一定看，APP 推送会被整屏划掉；而且这条不用重装 APK。 */
function openNotifySheet() {
  api('notify:config').then(function (cfg) {
    const c = cfg || {}
    const ov = sheet('每日提醒',
      '<div class="text-sm text-muted" style="margin-bottom:12px;line-height:1.8">每天定时把「今天该做的事」（该补货 / 该催款 / 哪里不对）发到你的微信或飞书。<br>不用装新版本、不用开着 APP。</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:11px 12px;border-radius:12px;background:var(--card2);border:1px solid var(--line)">' +
        '<span style="flex:1;font-size:15px;font-weight:700">开启每日提醒</span>' +
        '<button id="nf-on" style="width:62px;height:34px;border-radius:999px;border:none;background:' + (c.enabled ? 'var(--blue)' : 'var(--line)') + ';color:#fff;font-size:13px;font-weight:800">' + (c.enabled ? '已开' : '关闭') + '</button>' +
      '</div>' +
      '<div class="text-xs text-muted" style="margin-bottom:5px">机器人地址（企业微信：群设置 → 群机器人 → 添加 → 复制 Webhook 地址；飞书同理）</div>' +
      '<input id="nf-hook" value="' + escHtml(c.webhook || '') + '" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." style="width:100%;box-sizing:border-box;height:46px;border:1px solid var(--line);border-radius:12px;padding:0 12px;font-size:13px;background:var(--card2);color:var(--ink);outline:none">' +
      '<div class="text-xs text-muted" style="margin:10px 0 5px">每天几点发（0-23）</div>' +
      '<input id="nf-hour" type="number" min="0" max="23" value="' + (c.hour == null ? 7 : c.hour) + '" style="width:100%;box-sizing:border-box;height:46px;border:1px solid var(--line);border-radius:12px;padding:0 12px;font-size:15px;background:var(--card2);color:var(--ink);outline:none">' +
      '<div class="text-xs text-muted" style="margin-top:10px;line-height:1.75">内容只有「该补什么货 / 该催谁的款 / 哪里不对」，<b>不含具体金额明细和客户消费记录</b>。</div>' +
      '<div style="display:flex;gap:8px;margin-top:14px">' +
        '<button id="nf-test" style="flex:1;height:50px;border-radius:12px;border:1px solid var(--line);background:var(--card2);color:var(--blue);font-size:15px;font-weight:800">发一条测试</button>' +
        '<button id="nf-save" style="flex:1.4;height:50px;border-radius:12px;border:none;background:var(--blue);color:#fff;font-size:16px;font-weight:800">保存</button>' +
      '</div>')
    let enabled = !!c.enabled
    const onBtn = ov.querySelector('#nf-on')
    onBtn.onclick = function () {
      enabled = !enabled
      onBtn.textContent = enabled ? '已开' : '关闭'
      onBtn.style.background = enabled ? 'var(--blue)' : 'var(--line)'
    }
    const readForm = function () {
      return { enabled: enabled, webhook: String((ov.querySelector('#nf-hook') || {}).value || '').trim(), hour: parseInt((ov.querySelector('#nf-hour') || {}).value, 10) || 7 }
    }
    ov.querySelector('#nf-save').onclick = function () {
      const btn = ov.querySelector('#nf-save')
      btn.disabled = true; btn.textContent = '保存中…'
      api('notify:save', readForm()).then(function (r) {
        toast(r && r.enabled ? ('已开启：每天 ' + r.hour + ' 点提醒') : '已保存（未开启）')
        ov.remove()
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '保存'
        toast('保存失败：' + ((e && e.message) || '请重试'))
      })
    }
    ov.querySelector('#nf-test').onclick = function () {
      const btn = ov.querySelector('#nf-test')
      btn.disabled = true; btn.textContent = '发送中…'
      api('notify:save', readForm())
        .then(function () { return api('notify:test') })
        .then(function () { toast('已发送，去微信/飞书看看收到没'); fiTrack('notify:test', true, 0) })
        .catch(function (e) { toast('发送失败：' + ((e && e.message) || '检查地址')); fiTrack('notify:test', false, 0) })
        .then(function () { btn.disabled = false; btn.textContent = '发一条测试' })
    }
  }).catch(function (e) { toast('读设置失败：' + ((e && e.message) || '')) })
}

// ===== 我的反馈（反馈闭环的最后一环）=====
// 老板 2026-09-21 问「反馈渠道是什么？人工介入的后台怎么收到？」
// 光把反馈收上来没用 —— 用户得能看到「我们回了什么」，这条通道才活得下去。
// 所以：APP 里能看自己发过的反馈 + 官方回复；有新回复时「更多」入口带红点。
let fiFeedbackItems = null
function fiLoadMyFeedback() {
  const iid = fiInstallId()
  if (!iid) return Promise.resolve([])
  return fetch(FI_TELEMETRY_API + '/api/v1/app/feedback-mine?installId=' + encodeURIComponent(iid))
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (j) { fiFeedbackItems = (j && j.items) || []; return fiFeedbackItems })
    .catch(function () { return fiFeedbackItems || [] })
}
function fiReplyCount() { return (fiFeedbackItems || []).filter(function (x) { return x.reply }).length }
function fiUnseenReplies() {
  try { return Math.max(0, fiReplyCount() - Number(localStorage.getItem('fi-feedback-seen') || 0)) } catch (e) { return 0 }
}
function openMyFeedbackSheet() {
  fiLoadMyFeedback().then(function (items) {
    try { localStorage.setItem('fi-feedback-seen', String(fiReplyCount())) } catch (e) {}
    const list = items || []
    const ov = sheet('我的反馈',
      '<div class="text-sm text-muted" style="margin-bottom:10px;line-height:1.75">你发过的反馈和我们回的都在这里。有新回复会在「更多」上带个红点。</div>' +
      (list.length ? list.map(function (x) {
        return '<div style="padding:12px 0;border-bottom:1px solid var(--line2)">' +
          '<div style="font-size:14.5px;font-weight:700">' + escHtml(x.text) + '</div>' +
          '<div class="text-xs text-muted" style="margin-top:3px">' + escHtml(x.at || '') + '</div>' +
          (x.reply
            ? '<div style="margin-top:8px;padding:10px 12px;border-radius:10px;background:#e8f8ee;color:#0f9d68;font-size:14px;line-height:1.7"><b>我们的回复</b>（' + escHtml(x.repliedAt || '') + '）<br>' + escHtml(x.reply) + '</div>'
            : '<div class="text-xs text-muted" style="margin-top:6px">还没回复 —— 一般当天会看</div>') +
        '</div>'
      }).join('') : '<div class="text-sm text-muted" style="padding:14px 0">还没发过反馈。</div>') +
      '<button id="mfb-new" style="width:100%;height:50px;margin-top:14px;border-radius:12px;border:none;background:var(--blue);color:#fff;font-size:16px;font-weight:800">再提一条</button>')
    const nb = ov.querySelector('#mfb-new')
    if (nb) nb.onclick = function () { ov.remove(); openFeedbackSheet() }
  })
}

// ========== 今天该做的事（2026-09-21 主动触达）==========
// 老板：「软件通知这个问题，要自动」。
// 这套系统以前全是"用户想起来才打开"的工具，个体户忙起来根本不会主动开。
// 所以把账里已经有的数据算成几句话，**开机第一眼就摆在最上面**；外加服务端每天定时推微信。
let fiTodoData = null
function fiFetchTodo() {
  return api('report:todo').then(function (t) { fiTodoData = t; return t }).catch(function () { return null })
}
/** 顶部那条待办。没数据 / 没事就不占地方（不制造噪音） */
function fiRenderTodoBar(host) {
  if (!host) return
  const paint = function (t) {
    try {
      if (!t || !t.counts) { host.innerHTML = ''; return }
      const n = (t.counts.restockTotal || 0) + (t.counts.collect || 0) + (t.counts.anomalies || 0)
      if (!n) { host.innerHTML = ''; return }
      const urgent = (t.counts.anomalies || 0) > 0 || (t.counts.collect || 0) > 0
      host.innerHTML = '<button class="todorow' + (urgent ? ' warn' : '') + '">' +
        FiIcon('pulse', 14) +
        '<span class="txt">' + escHtml(String(t.headline || '').replace('今天该做的事：', '')) + '</span>' +
        '<span class="go">看看' + FiIcon('chevron', 12) + '</span>' +
        '</button>'
      host.querySelector('.todorow').onclick = openTodoSheet
    } catch (e) { /* 待办条坏了不能拖垮开单页 */ }
  }
  paint(fiTodoData)
  fiFetchTodo().then(paint)
}

/** 待办详情：一条条摊开，每条都能点着去处理 */
function openTodoSheet() {
  const t = fiTodoData
  if (!t) { toast('正在读今天的待办…'); fiFetchTodo().then(function () { if (fiTodoData) openTodoSheet() }); return }
  const sec = function (title, rows, empty) {
    return '<div class="font-bold" style="font-size:14px;margin:14px 0 6px">' + title + '</div>' +
      (rows.length ? rows.join('') : '<div class="text-xs text-muted" style="padding:4px 0">' + empty + '</div>')
  }
  const item = function (main, sub, jump) {
    return '<div class="todoi" data-jump="' + escHtml(jump || '') + '"><div style="flex:1;min-width:0"><div style="font-size:14.5px;font-weight:700">' + escHtml(main) + '</div>' +
      (sub ? '<div class="text-xs text-muted" style="margin-top:2px">' + escHtml(sub) + '</div>' : '') + '</div>' + FiIcon('chevron', 13) + '</div>'
  }
  const restock = (t.restock || []).map(function (r) { return item(r.name, '剩 ' + r.stock + '（预警 ' + r.threshold + '）· ' + (r.sku || ''), 'inbound') })
  if ((t.counts.restockTotal || 0) > restock.length) {
    restock.push('<div class="text-xs text-muted" style="padding:6px 0">…共 ' + t.counts.restockTotal + ' 样低于预警线，这里列最缺的 ' + restock.length + ' 样</div>')
  }
  const collect = (t.collect || []).map(function (c) {
    return item(c.name + '　欠 ¥' + (c.outstanding / 100).toFixed(2), (c.phone || '') + (c.lastDealAt ? ' · 上次 ' + String(c.lastDealAt).slice(0, 10) : ''), 'customers')
  })
  const anomalies = (t.anomalies || []).map(function (a) { return item(a.text, '', 'stock') })

  const ov = sheet('今天该做的事',
    '<div class="text-xs text-muted" style="margin-bottom:4px">' + escHtml(t.date || '') + ' · 每天自动算，不用你去翻账</div>' +
    sec('📦 该补货', restock, '库存都够') +
    sec('💰 该催款', collect, '没有欠款') +
    sec('⚠️ 对不上的地方', anomalies, '账目正常'))
  ov.querySelectorAll('[data-jump]').forEach(function (el) {
    const j = el.getAttribute('data-jump')
    if (!j) return
    el.onclick = function () { ov.remove(); navigate(j) }
  })
}

// ========== 更新说明 ==========
// 老板 2026-09-21：「自动提示有更新功能没有完善，还是需要人为去点击更新，即便是小更新也应该提示，
//               更新优化了什么，更新说明要提出来」
// 说明文件 update-notes.json 是**构建时**写进网页层自己的（见 scripts/build-web-bundle.mjs）：
// 热更换的就是整包代码，所以新版一跑起来就自带「这次改了什么」——不依赖跨域、断网也能看。
// （去 fetch junchengzn.com 那份 manifest 是行不通的：那边没有 CORS 头，APP 跑在 http://localhost 会被拦。）
let updateNotesCache = null
function loadUpdateNotes() {
  if (updateNotesCache) return Promise.resolve(updateNotesCache)
  return fetch('update-notes.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (j) { updateNotesCache = (j && typeof j === 'object') ? j : null; return updateNotesCache })
    .catch(function () { return null })
}

/** 更新说明面板：justUpdated=true 时是「刚更新完」的口吻，否则是「查看说明」 */
function openUpdateNotesPanel(version, notes, justUpdated) {
  const list = (Array.isArray(notes) && notes.length)
    ? '<div class="text-sm" style="line-height:1.95">' + notes.map(function (n) { return '· ' + escHtml(n) }).join('<br>') + '</div>'
    : '<div class="text-sm text-muted">这一版没写更新说明。</div>'
  sheet(justUpdated ? ('已更新到 ' + version) : ('更新说明 · ' + version),
    (justUpdated ? '<div class="text-sm" style="margin-bottom:10px;color:var(--ok);font-weight:700">这次是自动更新的，不用你动手。改了什么：</div>' : '') +
    list +
    '<div class="text-xs text-muted" style="margin-top:12px;line-height:1.7">改页面会自动热更（只下变化的文件，秒级生效）；只有动到原生壳（权限/插件/图标）才需要重装一次安装包。</div>')
}

/** 启动后判断要不要弹「已更新」：刚热更过，或跑着的版本和上次见过的不一样 */
function afterWebUpdate() {
  const running = String(WEB_VERSION_APPLIED || '').trim()
  if (!running) return
  let seen = ''
  try { seen = localStorage.getItem('fi-seen-web-version') || '' } catch (e) {}
  if (seen === running) return
  try { localStorage.setItem('fi-seen-web-version', running) } catch (e) {}
  // 第一次装（没有任何基准）不算「更新」，不打扰；但原生插件说刚热更过，就一定要说一声
  if (!seen && !WEB_JUST_UPDATED) return
  if (!TOKEN) return   // 还没登录：先让登录面板出来，别两个弹层叠在一起
  loadUpdateNotes().then(function (n) {
    const notes = (n && n.version === running && Array.isArray(n.notes)) ? n.notes : []
    openUpdateNotesPanel(running, notes, true)
  })
}

/** 更多页「更新说明」：当前版本 + 最近几版改了什么 */
function openUpdateHistory() {
  const running = String(WEB_VERSION_APPLIED || APP_VERSION)
  loadUpdateNotes().then(function (n) {
    if (!n) {
      sheet('更新说明', '<div class="text-sm text-muted">这台设备上还没有更新说明文件（多半是安装包自带的老版本）。连上网自动热更一次之后就有了。</div>')
      return
    }
    const hist = Array.isArray(n.history) ? n.history : []
    const block = function (h, isCur) {
      const body = (Array.isArray(h.notes) && h.notes.length)
        ? '<div class="text-sm" style="line-height:1.9">' + h.notes.map(function (x) { return '· ' + escHtml(x) }).join('<br>') + '</div>'
        : '<div class="text-xs text-muted">（这一版没写说明）</div>'
      return '<div style="padding:10px 0;border-bottom:1px solid var(--line2)">' +
        '<div class="flex" style="align-items:center;gap:8px;margin-bottom:5px">' +
        '<b style="font-size:13.5px">' + (isCur ? '当前 · ' : '') + 'v' + escHtml(String(h.version || '')) + '</b>' +
        '<span class="text-xs text-muted">' + escHtml(String(h.date || '')) + '</span></div>' + body + '</div>'
    }
    sheet('更新说明',
      '<div class="text-sm text-muted" style="margin-bottom:8px">这台手机跑的是网页层 <b>' + escHtml(running) + '</b>（壳 ' + escHtml(APP_VERSION) + '）。</div>' +
      (hist.length ? hist.map(function (h) { return block(h, h.version === running) }).join('') : block(n, true)))
  })
}

// ========== 扫码 ==========
let scanCallback = null

// 真·扫码：装了 APP 的走**原生条码扫描**（摄像头实时识别，对准就出结果，不用拍照）；
// 浏览器页面没有这个插件，自动退回「拍照识别 / 手输条码」，两条路都在面板上，不会死胡同。
// 取原生条码扫描器。
// ⚠️ 老板 2026-09-21 反馈「条码入档摄像头无法打开、连提示权限都没有，而且是拍照不是扫码」，根因就在这里：
//   Capacitor 7 的 window.Capacitor.Plugins 是**普通对象**，不会为「原生已注册但 JS 没注册」的插件自动建代理
//   （见 @capacitor/core/dist/capacitor.js：Plugins[name] 只在 registerPlugin() 里赋值）。
//   所以光把插件打进 APK、在 capacitor.plugins.json 里登记是不够的 —— 这里必须自己 registerPlugin 一次，
//   否则 Capacitor.Plugins.BarcodeScanner 永远是 undefined → 面板退化成「手输 + 拍照识别」，
//   原生实时扫码那条路整条不存在（相机当然打不开、也不会有任何权限弹窗）。
function nativeBarcodeScanner() {
  try {
    const C = window.Capacitor
    if (!C) return null
    if (C.Plugins && C.Plugins.BarcodeScanner) return C.Plugins.BarcodeScanner
    if (C.registerPlugin && C.isPluginAvailable && C.isPluginAvailable('BarcodeScanner')) {
      return C.registerPlugin('BarcodeScanner')
    }
    return null
  } catch (e) { return null }
}
// 返回 'ok'（扫到了）/ 'handled'（跑完但没扫到）/ 'unavailable'（没有原生插件）
async function nativeScanOnce(cb) {
  const BS = nativeBarcodeScanner()
  if (!BS) return 'unavailable'
  const ov = document.getElementById('scan-overlay')
  const body = document.body
  let resolved = true
  try {
    if (BS.checkPermission) {
      let p = null
      try { p = await BS.checkPermission({ force: true }) } catch (e) { /* 插件老版本可能没有这个参数，继续走 startScan 让它自己申请 */ }
      // 插件返回的是 {granted:true} / {neverAsked:true} / {denied:true}（**不是** {camera:'granted'}）。
      // 只有「被永久拒绝」才拦下来并告诉老板去哪儿开；其余情况都继续，让 startScan 自己弹权限框。
      if (p && p.denied && p.granted !== true) {
        toast('相机权限被拒了：手机「设置 → 应用 → AI 智能进销存 → 权限」里把「相机」打开再回来')
        return 'handled'
      }
    }
    // 让出画面：相机预览在 WebView 背后，网页底色不透明就一片白/黑（见 index.html 的 .fi-scanning 说明）
    body.classList.add('fi-scanning')
    if (ov) ov.classList.add('scanning')
    if (BS.hideBackground) await BS.hideBackground()
    const r = await BS.startScan({ targetedFormats: ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'ITF', 'QR_CODE'] })
    if (r && r.hasContent && r.content) { cb(String(r.content).trim()); return 'ok' }
    if (!r || r.hasContent !== false) resolved = false
    toast('没扫到，把条码对准框里再试')
    return 'handled'
  } catch (e) {
    toast('扫码没成功：' + ((e && e.message) || '请重试'))
    return 'handled'
  } finally {
    // 无论成功失败都要把画面还回来，否则整页一直透明（像坏了一样）
    try { if (BS.showBackground) await BS.showBackground() } catch (e2) { /* 忽略 */ }
    body.classList.remove('fi-scanning')
    if (ov) ov.classList.remove('scanning')
    if (resolved) { /* 已结算，无需额外动作 */ }
  }
}
// 主动停止扫描：把挂着的 startScan 结算掉（resolveScan:true → {hasContent:false}），相机才会关
async function nativeStopScan() {
  const BS = nativeBarcodeScanner()
  if (!BS || !BS.stopScan) return
  try { await BS.stopScan({ resolveScan: true }) } catch (e) { try { await BS.stopScan() } catch (e2) { /* 忽略 */ } }
}

// 扫码面板：原生实时扫码（装了 APP）+ 手动输入 + 拍照识别三个入口。
function openScanner(cb, hint) {
  const hasNative = !!nativeBarcodeScanner()
  scanCallback = cb
  const overlay = document.createElement('div')
  overlay.id = 'scan-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.95);z-index:300;display:flex;flex-direction:column;justify-content:center;padding:24px;color:#e6edf5'
  overlay.innerHTML =
    // 扫描中：只留取景框 + 停止按钮（其余内容必须藏掉，否则不透明的面板会挡住背后的相机画面）
    '<div class="scan-live-ui">' +
      '<div style="text-align:center;color:#fff;font-size:15px;font-weight:700;text-shadow:0 1px 8px rgba(0,0,0,.7)">把条码放进框里，扫到自动填</div>' +
      '<div class="scan-frame"><i></i><i></i><i></i><i></i></div>' +
      '<button id="scan-stop" style="width:100%;height:54px;border-radius:14px;border:none;background:rgba(255,255,255,.94);color:#0a1628;font-size:17px;font-weight:800">停止扫描</button>' +
    '</div>' +
    '<div class="scan-form">' +
    '<div style="font-size:18px;font-weight:700;margin-bottom:8px">扫码 / 输条码</div>' +
    '<div style="font-size:13px;color:#8fa3c0;margin-bottom:14px">' + (hint || '扫描或输入商品条码') + '</div>' +
    (hasNative
      ? '<button id="scan-live" style="width:100%;height:74px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:19px;font-weight:800;margin-bottom:12px">' + FiIcon('camera', 15) + ' 开始扫描（把条码对准框里）</button>' +
        '<div id="scan-live-tip" style="font-size:12px;color:#8fa3c0;margin-bottom:14px">摄像头实时识别，扫到自动填。也可以用下面的方式。</div>'
      : '') +
    '<input id="scan-input" type="text" placeholder="输入条码数字" style="height:56px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);border-radius:12px;color:#fff;font-size:20px;padding:0 14px;margin-bottom:12px;width:100%;outline:none">' +
    '<div style="display:flex;gap:10px">' +
      '<button id="scan-ok" style="flex:1;height:54px;border-radius:12px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:17px;font-weight:800">确认</button>' +
      '<button id="scan-cam" style="flex:1;height:54px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:17px">' + FiIcon('camera', 15) + ' 拍照识别</button>' +
    '</div>' +
    '<button id="scan-cancel" style="margin-top:12px;height:44px;border-radius:10px;border:none;background:transparent;color:#8fa3c0;font-size:15px">取消</button>' +
    '</div>'
  document.body.appendChild(overlay)

  const submitCode = (code) => {
    const v = (code || '').trim()
    if (!v) { toast('请输入条码'); return }
    overlay.remove()
    if (scanCallback) { const cb2 = scanCallback; scanCallback = null; cb2(v) }
  }

  document.getElementById('scan-ok').onclick = () => submitCode(document.getElementById('scan-input').value)
  document.getElementById('scan-cancel').onclick = () => { overlay.remove(); scanCallback = null }
  document.getElementById('scan-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCode(e.target.value) })

  document.getElementById('scan-cam').onclick = () => {
    // 拍照识别：调起相机 → 本地解析；失败自动回到手动输入框（已在面板上，不会死胡同）
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.capture = 'environment'
    input.onchange = function () {
      if (!input.files || !input.files[0]) return
      const file = input.files[0]
      const reader = new FileReader()
      reader.onload = function () {
        const img = new Image()
        img.onload = async function () {
          try {
            const code = await decodeBarcode(img)
            if (code) submitCode(code)
            else toast('没识别出条码，手动输一下')
          } catch { toast('识别失败，手动输一下') }
        }
        img.src = reader.result
      }
      reader.readAsDataURL(file)
    }
    input.click()
  }

  // 原生实时扫码：打开面板就自动起一次（收银员不用多点一下），按钮还能再扫
  const liveBtn = document.getElementById('scan-live')
  if (liveBtn) {
    liveBtn.onclick = async () => {
      liveBtn.disabled = true; liveBtn.textContent = '正在打开摄像头…'
      try { await nativeScanOnce(submitCode) } finally {
        liveBtn.disabled = false; liveBtn.innerHTML = FiIcon('camera', 16) + ' 再扫一次'
      }
    }
    // 停止按钮：扫描中面板只剩取景框，得给个出口（否则相机一直开着、只能按系统返回键）
    const stopBtn = document.getElementById('scan-stop')
    if (stopBtn) stopBtn.onclick = () => { nativeStopScan() }
    setTimeout(() => { liveBtn.click() }, 250)
  } else {
    // 浏览器页面没有原生插件：聚焦手输框
    setTimeout(() => { const i = document.getElementById('scan-input'); if (i) i.focus() }, 100)
  }
}

async function decodeBarcode(img) {
  // 优先浏览器原生 BarcodeDetector（Chrome 支持，能解析图片）
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code'] })
      const codes = await detector.detect(img)
      if (codes.length > 0) return codes[0].rawValue
    } catch { /* 降级 zxing */ }
  }
  // 兜底：本地 zxing 解析（离线打包，不依赖网络/安全上下文）
  if (window.ZXing) {
    const reader = new ZXing.BrowserMultiFormatReader()
    const result = await reader.decodeFromImageElement(img)
    return result ? result.getText() : null
  }
  return null
}

// 首屏按需加载：只预载 4 个高频页（开单/入库/库存/今日），其余首次进入时才注入脚本，
// 缩短启动白屏；离线也能用 —— sw.js 的预缓存里已经包含全部页面脚本。
const LAZY_PAGES = { ai: 1, restock: 1, expiring: 1, waste: 1, kits: 1, customers: 1, expenses: 1, suppliers: 1, stocktake: 1, parts: 1, product: 1, customer: 1, receipts: 1 }
const lazyLoading = {}
function loadPageScript(name) {
  if (pages[name] || !LAZY_PAGES[name]) return Promise.resolve(!!pages[name])
  if (lazyLoading[name]) return lazyLoading[name]
  lazyLoading[name] = new Promise(function (resolve) {
    const s = document.createElement('script')
    s.src = 'pages/' + name + '.js'
    s.onload = function () { resolve(true) }
    s.onerror = function () { resolve(false) }
    document.head.appendChild(s)
  })
  return lazyLoading[name]
}

// ========== 页面注册 ==========
const pages = {}
function page(name, fn) { pages[name] = fn }


// ========== 撤回误操作（删商品 / 报损 / 入库）==========
// 服务端在这三类写操作前留了可逆快照（undo_log），这里只负责列出来 + 一键还原。
// 出库请用「退货」（会计口径正确）；盘点请重新盘点（本来就有差异记录）。
function openUndoPanel() {
  const old = document.getElementById('undo-panel'); if (old) old.remove()
  const ov = document.createElement('div')
  ov.id = 'undo-panel'
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.97);z-index:310;padding:20px;color:#e6edf5;overflow:auto'
  ov.innerHTML =
    '<div style="font-size:21px;font-weight:800;margin-bottom:6px">' + FiIcon('undo', 15) + ' 撤回误操作</div>' +
    '<div style="font-size:13px;color:#8fa3c0;line-height:1.7;margin-bottom:14px">最近做过的「删商品 / 报损 / 入库」都在这里，点错了可以一键还原。<br>卖出去的单子请用「退货」（账才对得上）。</div>' +
    '<div id="undo-list" style="font-size:14px;color:#8fa3c0">加载中…</div>' +
    '<button id="undo-close" style="width:100%;height:50px;margin-top:16px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px;font-weight:700">关闭</button>'
  document.body.appendChild(ov)
  const list = ov.querySelector('#undo-list')
  ov.querySelector('#undo-close').onclick = function () { ov.remove() }

  function fmtTime(s) { try { return new Date(s).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch (e) { return s } }
  function load() {
    list.textContent = '加载中…'
    api('undo:list', { limit: 20 }).then(function (rows) {
      rows = rows || []
      if (!rows.length) { list.innerHTML = '<div style="padding:18px 0">最近没有可撤回的操作。<br><span style="font-size:12px">（删商品/报损/入库都会自动留一条）</span></div>'; return }
      list.innerHTML = ''
      rows.forEach(function (r) {
        const card = document.createElement('div')
        card.style.cssText = 'background:rgba(255,255,255,.07);border-radius:12px;padding:12px;margin-bottom:10px'
        const done = !!r.undone_at
        card.innerHTML =
          '<div style="font-weight:800;font-size:15px;' + (done ? 'color:#7d8ba0;text-decoration:line-through' : '') + '">' + escHtml(r.label || '') + '</div>' +
          '<div style="font-size:12px;color:#8fa3c0;margin-top:3px">' + escHtml(r.detail || r.channel || '') + ' · ' + escHtml(fmtTime(r.at)) + (r.operator ? ' · ' + escHtml(r.operator) : '') + '</div>' +
          '<div style="margin-top:8px">' + (done
            ? '<span style="font-size:12px;color:#8ce0a8">已撤回</span>'
            : '<button data-undo="' + r.id + '" style="height:38px;padding:0 16px;border-radius:9px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:15px;font-weight:800">撤回这一步</button>') +
          '</div>'
        list.appendChild(card)
      })
      list.querySelectorAll('[data-undo]').forEach(function (b) {
        b.onclick = function () {
          const id = Number(b.getAttribute('data-undo'))
          if (!confirm('撤回这一步？会把这一步改动的库存/流水还原回去。')) return
          b.disabled = true; b.textContent = '撤回中…'
          api('undo:apply', { id: id, operator: getOperator() }).then(function () {
            toast('已撤回'); load()
          }).catch(function (e) { toast('撤回失败：' + (e.message || '')); load() })
        }
      })
    }).catch(function (e) {
      list.innerHTML = '<div style="color:#ffb4b4">读不到记录：' + escHtml(e.message || '') + '</div>'
    })
  }
  load()
}

// ========== 安装与使用统计（老板能知道装了几台、今天几台在用）==========
// 只上报「安装号 + 版本 + 机型」，不带任何经营数据 —— 统计的是"用得怎么样"，不是"卖了什么"。
// 手机端连的是店里那台中心库（本来就是 https 且已登录），由它转存并转发官方服务，
// 避免手机 WebView 因为 http 混合内容把统计请求拦掉。
function installId() {
  try {
    let v = localStorage.getItem('fi-install-id')
    if (!v) { v = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); localStorage.setItem('fi-install-id', v) }
    return v
  } catch (e) { return '' }
}
const APP_SHARE_URL = 'http://43.128.20.39:17533/dl/app.apk'
let pinged = false
function appPing() {
  if (pinged || !TOKEN) return
  const id = installId()
  if (!id) return
  pinged = true
  const ua = navigator.userAgent || ''
  api('app:ping', {
    installId: id,
    version: APP_VERSION,
    webVersion: WEB_VERSION_APPLIED || '',
    platform: /Android/i.test(ua) ? 'android' : (/iPhone|iPad/i.test(ua) ? 'ios' : 'web'),
    device: (ua.match(/;\s*([^;)]+)\s+Build\//) || [])[1] || '',
  }).catch(function () { /* 统计失败不影响使用 */ })
}
/** 分享给同事：优先调系统分享面板，退回复制链接 */
function shareApp() {
  const text = 'AI 智能进销存 手机版 —— 装在手机上开单、查库存、看今天赚多少'
  if (navigator.share) {
    navigator.share({ title: 'AI 智能进销存', text: text, url: APP_SHARE_URL }).catch(function () { copyAppLink() })
    return
  }
  copyAppLink()
}
function copyAppLink() {
  const done = function () { toast('下载链接已复制，粘到微信发给同事即可') }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(APP_SHARE_URL).then(done, function () { prompt('复制这个链接发给同事：', APP_SHARE_URL) })
      return
    }
  } catch (e) { /* 落到 prompt */ }
  prompt('复制这个链接发给同事：', APP_SHARE_URL)
}
/** 使用情况：装了几台 / 今天几台在用 / 版本分布（数据来自中心库统计表） */
async function openUsagePanel() {
  const ov = sheet('使用情况', '<div id="us-body" class="text-sm text-muted">正在读取…</div>' +
    '<button id="us-share" class="okbtn" style="margin-top:14px">' + FiIcon('share', 16) + ' 分享给同事安装</button>')
  ov.querySelector('#us-share').onclick = function () { ov.remove(); shareApp() }
  const body = ov.querySelector('#us-body')
  try {
    const s = (await api('app:stats')) || {}
    const days = Array.isArray(s.days) ? s.days : []
    const max = Math.max(1, ...days.map(function (d) { return d.active || 0 }))
    body.innerHTML =
      '<div class="stat-grid">' +
        '<div class="stat"><div class="k">装了这个 APP 的设备</div><div class="v">' + (s.devices || 0) + ' 台</div></div>' +
        '<div class="stat"><div class="k">今天在用</div><div class="v">' + (s.today || 0) + ' 台</div></div>' +
        '<div class="stat"><div class="k">近 7 天用过</div><div class="v">' + (s.week || 0) + ' 台</div></div>' +
        '<div class="stat"><div class="k">累计打开次数</div><div class="v">' + (s.launches || 0) + ' 次</div></div>' +
      '</div>' +
      (days.length
        ? '<div style="margin-top:16px;font-size:12px;font-weight:800;color:var(--sub)">最近 7 天每天在用</div>' +
          days.map(function (d) {
            return '<div style="margin-top:9px"><div class="flex" style="justify-content:space-between;font-size:12px"><span>' + escHtml(String(d.date).slice(5)) + '</span><span class="text-muted">' + (d.active || 0) + ' 台' + (d.added ? ' · 新增 ' + d.added : '') + '</span></div>' +
              '<div class="bar"><i style="width:' + Math.round(((d.active || 0) / max) * 100) + '%"></i></div></div>'
          }).join('')
        : '') +
      (Array.isArray(s.versions) && s.versions.length
        ? '<div style="margin-top:16px;font-size:12px;font-weight:800;color:var(--sub)">版本分布</div>' +
          s.versions.map(function (v) {
            return '<div class="flex" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line2);font-size:13px"><span>' + escHtml(v.version || '未知') + '</span><span class="text-muted">' + v.n + ' 台</span></div>'
          }).join('')
        : '') +
      '<div class="text-xs text-muted" style="margin-top:14px;line-height:1.7">只统计设备数与打开次数（安装号 + 版本 + 机型），不采集任何经营数据、不采集个人信息。分享链接里带了下载计数，谁装的都能对得上。</div>'
  } catch (e) {
    body.innerHTML = '<div class="text-red text-sm">读不到统计：' + escHtml(e.message || '') + '</div>'
  }
}
/** 界面字号：三档，整套等比缩放 */
function openSizeSheet() {
  const cur = savedUiSize()
  const ov = sheet('界面字号',
    '<div class="text-sm text-muted" style="margin-bottom:12px">觉得字大挤得慌就调「小」，看不清就调「大」；整个界面一起变，不用重开。</div>' +
    '<div class="sizes" id="sz"><button data-sz="s">小</button><button data-sz="m">标准</button><button data-sz="l">大</button></div>')
  ov.querySelectorAll('[data-sz]').forEach(function (b) {
    const v = b.getAttribute('data-sz')
    if (v === cur) b.classList.add('on')
    b.onclick = function () {
      applyUiSize(v)
      ov.querySelectorAll('[data-sz]').forEach(function (x) { x.classList.remove('on') })
      b.classList.add('on')
    }
  })
}

// ========== 右上角「登录账号」（顶栏一直挂着）==========
// 老板要的：谁登录的一眼看到。点一下能看登录方式、换账号、切换操作员、退出。
// ========== 顶部安全区（手机状态栏）==========
// 安卓 15+ 强制 edge-to-edge：网页会直接顶到状态栏下面，标题被盖住。
// 先问系统要（env(safe-area-inset-top)）；真机上拿不到就退到常见状态栏高度（宁多一点白，别挡标题）。
/** 把「实际可见高度」写进 --vh-full（真机 100dvh 可能含系统 UI，导致整页偏高、底部被顶出去） */
function applyViewportHeight() {
  try {
    const vv = window.visualViewport
    const h = Math.round((vv && vv.height) || window.innerHeight || document.documentElement.clientHeight || 0)
    if (h > 200) document.documentElement.style.setProperty('--vh-full', h + 'px')
  } catch (e) { /* 拿不到就用 dvh */ }
}

/** 系统条是不是"叠在"网页上（edge-to-edge）？
 *  —— 只有叠着才需要我们自己垫；系统已经让开位置了（下面那截是黑的/灰的），再垫一次就是把内容往里挤。
 *  判断依据：网页可见高度 ≈ 整块屏幕高度 → 铺满整屏 = 叠着的。 */
function isEdgeToEdge(screenH, innerH) {   // 两个参数只为测试可传，正常不传
  try {
    const sh = Math.round(screenH || (window.screen && window.screen.height) || 0)
    const ih = Math.round(innerH || window.innerHeight || 0)
    if (!sh || !ih) return true
    return ih >= sh - 8
  } catch (e) { return true }
}

function initSafeArea() {
  // 系统已经给让出位置了 → 不许再垫（老板反馈：店名那一条要往上、功能栏要往下，就是被这个垫出来的）
  const overlay = isEdgeToEdge()
  let top = 0
  try {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);pointer-events:none'
    document.body.appendChild(probe)
    top = Math.round(probe.getBoundingClientRect().height || 0)
    probe.remove()
  } catch (e) { top = 0 }
  const native = !!(window.Capacitor && (window.Capacitor.isNativePlatform ? window.Capacitor.isNativePlatform() : !!window.Capacitor.Plugins))
  // 没拿到 env() 说明 WebView 没有顶到状态栏下面（系统已经让开了），就不该再垫 28px —— 那会把店名那一条压下去
  if (!top && native) top = 6
  try { document.documentElement.style.setProperty('--safe-top', top + 'px') } catch (e) {}
  // 底部：安卓三键导航/手势条会盖住最下面的东西（老板说"看不到结账按钮"很可能就是这个）
  let bottom = 0
  try {
    const probe2 = document.createElement('div')
    probe2.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);pointer-events:none'
    document.body.appendChild(probe2)
    bottom = Math.round(probe2.getBoundingClientRect().height || 0)
    probe2.remove()
  } catch (e) { bottom = 0 }
  if (!bottom && native) bottom = 3    // 真机拿不到就给一点点兜底（12 -> 6 -> 3，功能栏一步步往下压）
  // 兜住离谱值：env() 在某些机型/某些状态下会给出很大的数，直接变成"购物清单下面一大片白"
  if (bottom > 40) bottom = 40
  if (top > 64) top = 64
  if (!overlay) { top = 0; bottom = 0 }   // 系统条没压着网页：一点都不用垫
  try { document.documentElement.style.setProperty('--safe-bottom', bottom + 'px') } catch (e) {}
  applyViewportHeight()
  // 排障用：把关键尺寸打到 console（adb logcat 里搜 [fi] 就能看到真机实测值）
  try {
    setTimeout(function () {
      const g = function (s) { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)] }
      console.log('[fi] viewport ' + JSON.stringify({
        innerH: window.innerHeight, vvH: window.visualViewport ? Math.round(window.visualViewport.height) : null,
        dvh: (function () { const d = document.createElement('div'); d.style.height = '100dvh'; document.body.appendChild(d); const h = Math.round(d.getBoundingClientRect().height); d.remove(); return h })(),
        vhFull: getComputedStyle(document.documentElement).getPropertyValue('--vh-full').trim(),
        safeTop: getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim(),
        safeBottom: getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom').trim(),
        phone: g('.phone'), top: g('.pos-top'), mid: g('.pos-mid'), cart: g('.pos-cart'), tabs: g('.tabs'), docH: document.documentElement.scrollHeight,
      }))
    }, 1500)
  } catch (e) {}
}

/** 屏幕适配自检：真机上看不到 console，就把关键尺寸摊在屏幕上 ——
 *  以后再有"功能栏没贴底/中间有空白"，让老板点一下发张图，就不用猜了。 */
function openScreenDiag() {
  const box = function (s) { const el = document.querySelector(s); if (!el) return '—'; const r = el.getBoundingClientRect(); return Math.round(r.top) + ' → ' + Math.round(r.bottom) }
  const dvh = (function () { try { const d = document.createElement('div'); d.style.height = '100dvh'; document.body.appendChild(d); const h = Math.round(d.getBoundingClientRect().height); d.remove(); return h } catch (e) { return '—' } })()
  const css = function (k) { try { return getComputedStyle(document.documentElement).getPropertyValue(k).trim() || '0' } catch (e) { return '—' } }
  const rows = [
    ['整屏高度 screen.h', (window.screen ? Math.round(window.screen.height) : 0) + ''],
    ['是否叠在系统条上', isEdgeToEdge() ? '是（要垫安全区）' : '否（系统已让开，不垫）'],
    ['屏幕（WebView 高度）', window.innerHeight + ''],
    ['visualViewport', window.visualViewport ? Math.round(window.visualViewport.height) + '' : '—'],
    ['100dvh', dvh + ''],
    ['顶部安全区', css('--safe-top')],
    ['底部安全区', css('--safe-bottom')],
    ['整页 .phone', box('.phone')],
    ['页面区 #app', box('#app')],
    ['功能栏 .tabs', box('.tabs')],
    ['文档总高', document.documentElement.scrollHeight + ''],
  ]
  sheet('屏幕适配自检',
    '<div class="text-sm text-muted" style="margin-bottom:10px">这是这台手机实测的排版尺寸。<b>「功能栏 .tabs」的下边 = 屏幕高度</b>就说明贴底了；不是的话把这张图发我。</div>' +
    rows.map(function (r) {
      return '<div class="flex" style="justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line2);font-size:13px"><span class="text-muted">' + r[0] + '</span><b style="font-variant-numeric:tabular-nums">' + r[1] + '</b></div>'
    }).join(''))
}

/** 图片同步自检：老板说「我这台手机拍的照片，别的手机看不到」时，让他点这里，
 *  把结论摊在屏幕上（真机看不到 console）。分了四段：能不能造图 / 账本在哪 / 有几件带图 / 能不能读回来。
 *  照片是存在「账本那台机器」（中心库服务器）上的，所以第 3、4 段正常 = 跨手机就是通的。 */
function openPhotoSyncDiag() {
  const rows = []
  const line = function (k, v, flag) {
    const color = flag === true ? 'color:var(--ok)' : flag === false ? 'color:var(--danger)' : ''
    rows.push('<div class="flex" style="justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line2);font-size:13px"><span class="text-muted">' + escHtml(k) + '</span><b style="font-variant-numeric:tabular-nums;' + color + '">' + escHtml(String(v)) + '</b></div>')
  }
  const ov = sheet('图片同步自检', '<div id="pdiag" class="text-sm text-muted">检查中…</div>')
  const box = ov.querySelector('#pdiag')
  ;(async function () {
    // ① 本机能不能「造出」一张图 —— 这一步失败，拍照永远存不上，而且与服务器无关
    let canMake = false
    let makeMsg = ''
    try {
      const c = document.createElement('canvas'); c.width = 120; c.height = 120
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('画布不可用')
      ctx.fillStyle = '#2563eb'; ctx.fillRect(0, 0, 120, 120)
      const b64 = String(c.toDataURL('image/jpeg', 0.85).split(',')[1] || '')
      canMake = b64.length > 200
      makeMsg = canMake ? ('正常（' + Math.round(b64.length / 1024) + 'KB）') : '生成不出来（空图）'
    } catch (e) { makeMsg = '失败：' + ((e && e.message) || e) }
    line('① 本机造图能力', makeMsg, canMake)
    // ② 这台手机连的是哪个账本
    line('② 账本服务器', SERVER || '（没连上）', !!SERVER)
    line('③ 网页层版本', (WEB_VERSION_APPLIED || APP_VERSION) + (WEB_USING_BUNDLE ? '（热更）' : '（安装包自带）'), null)
    // ④ 中心库上到底有几件商品带图，再真读一张回来（别的手机读的就是这个地址）
    let withPhoto = []
    let total = 0
    try {
      const list = await api('product:list', { limit: 1000 })
      total = (list || []).length
      withPhoto = (list || []).filter(function (p) { return p.photo_path })
      line('④ 商品总数 / 带图', total + ' / ' + withPhoto.length, null)
    } catch (e) {
      line('④ 读商品列表', '失败：' + ((e && e.message) || e), false)
    }
    if (withPhoto.length) {
      try {
        const p = withPhoto[0]
        const res = await fetch(FiPhoto.productPhotoUrl(p.photo_path, p.updated_at), { method: 'GET' })
        line('⑤ 读回一张图', res.ok ? ('正常（HTTP ' + res.status + '）') : ('失败 HTTP ' + res.status), res.ok)
      } catch (e) {
        line('⑤ 读回一张图', '异常：' + ((e && e.message) || e), false)
      }
    } else {
      line('⑤ 读回一张图', '中心库上还没有任何商品图', false)
    }
    box.innerHTML = rows.join('') +
      '<div class="text-xs text-muted" style="margin-top:12px;line-height:1.75">' +
      (canMake
        ? '本机能正常拍照生成图片。<br>'
        : '<b style="color:var(--danger)">本机造不出图</b> —— 拍照会失败，这是手机内存/画布的问题，跟网络无关。<br>') +
      '照片存在「账本那台机器」上（不是存在这台手机里）。所以只要 ④ 有带图的商品、⑤ 读得回来，' +
      '一台手机拍的图，另一台手机打开同一个商品就能看到；反过来，如果 ⑤ 失败，才是真的没同步过去。' +
      '</div>'
  })()
}

function renderAccountChip() {
  const el = document.getElementById('acctChip')
  if (!el) return
  const lm = loginMethod()
  const label = lm.byAccount ? lm.account : (TOKEN ? '连接码接入' : '未登录')
  el.className = 'acct-chip' + (lm.byAccount ? '' : ' warn')
  el.innerHTML = '<span class="av">' + escHtml(String(label).trim().slice(0, 1) || '?') + '</span>' +
    '<span class="nm">' + escHtml(label) + '</span>'
  el.onclick = openAccountSheet
}
/** 退出登录（更多页和右上角账号面板共用同一段逻辑） */
function logoutNow() {
  if (!confirm('退出登录？\n\n退出后这台手机就看不到账本了，下次要用账号密码重新登录（离线攒着还没上传的单据也会一起清掉，请先确认没有待上传）。')) return
  try {
    localStorage.removeItem('fi-mobile-token')
    localStorage.removeItem('fi-server')
    localStorage.removeItem('fi-account')
  } catch (e) {}
  toast('已退出，正在返回登录页…')
  setTimeout(function () { location.reload() }, 500)
}
function openAccountSheet() {
  const lm = loginMethod()
  const info = [
    ['账号', lm.byAccount ? lm.account : '（还没用账号密码登录）'],
    ['登录方式', lm.byAccount ? ('账号密码' + (lm.deviceToken ? ' · 换连接码会自动恢复' : '')) : '连接码接入'],
    ['当前操作员', getOperator()],
    ['账本', savedServer() || SERVER || '本机'],
  ]
  const ov = sheet('登录账号',
    '<div class="list" style="margin:0 0 12px">' + info.map(function (r) {
      return '<div class="row" style="cursor:default"><div class="rt">' +
        '<div class="a" style="font-size:11.5px;color:var(--sub);font-weight:600">' + escHtml(r[0]) + '</div>' +
        '<div class="b" style="color:var(--ink);font-size:14px;font-weight:700;margin-top:2px">' + escHtml(String(r[1])) + '</div></div></div>'
    }).join('') + '</div>' +
    '<button id="ac-login" class="okbtn">' + (lm.byAccount ? '切换账号 / 重新登录' : '用账号密码登录') + '</button>' +
    '<div class="flex" style="gap:8px;margin-top:10px">' +
      '<button id="ac-op" style="flex:1;height:44px;border-radius:12px;border:1px solid var(--line);background:var(--card2);font-size:14px;font-weight:700;color:var(--ink)">切换操作员</button>' +
      '<button id="ac-conn" style="flex:1;height:44px;border-radius:12px;border:1px solid var(--line);background:var(--card2);font-size:14px;font-weight:700;color:var(--ink)">账号与连接</button>' +
    '</div>' +
    '<button id="ac-out" style="width:100%;height:44px;margin-top:10px;border-radius:12px;border:1px solid var(--danger-l);background:var(--danger-l);font-size:14px;font-weight:700;color:var(--danger)">退出登录</button>' +
    (lm.byAccount ? '' : '<div class="text-xs text-muted" style="margin-top:10px;line-height:1.7">现在这台手机是粘连接码接进来的：店里换过连接码就得重新粘。用账号密码登录一次，以后会自动恢复，忘了密码也能找回。</div>'))
  ov.querySelector('#ac-login').onclick = function () { ov.remove(); openLoginPanel(false, lm.byAccount ? 'switch' : 'bind') }
  ov.querySelector('#ac-op').onclick = function () { ov.remove(); openOperatorPanel() }
  ov.querySelector('#ac-conn').onclick = function () { ov.remove(); openConnectPanel() }
  ov.querySelector('#ac-out').onclick = function () { ov.remove(); logoutNow() }
}

page('more', (app) => {
  app.innerHTML = ''

  // 顶部：现在用的是哪个账本 / 谁在用（多设备多店最容易搞混的就是这个）
  const head = document.createElement('div')
  head.className = 'card'
  head.style.marginTop = '14px'
  head.innerHTML =
    '<div class="flex" style="align-items:center;gap:11px">' +
      '<div style="width:38px;height:38px;border-radius:11px;background:var(--blue-l);color:var(--blue);display:flex;align-items:center;justify-content:center;flex:none">' + FiIcon('store', 20) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div class="font-bold" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(savedAccount() || '用连接码接入') + '</div>' +
        '<div class="text-xs text-muted" style="margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(savedServer() || SERVER || '本机账本') + '</div>' +
      '</div>' +
      '<button id="op-switch" style="border:none;background:var(--blue-l);border-radius:999px;padding:7px 12px;font-size:12px;font-weight:800;color:var(--blue);display:flex;align-items:center;gap:5px;flex:none">' + FiIcon('user', 14) + escHtml(getOperator()) + '<span style="font-weight:600;opacity:.75">换人</span></button>' +
    '</div>' +
    '<div class="text-xs text-muted" style="margin-top:8px">这台手机现在记谁的名字：开单/入库/报损都算在 TA 头上 · 点右上角换人</div>'
  app.appendChild(head)
  head.querySelector('#op-switch').onclick = function () { toast('换人：点一个名字就行，之后开单都记在 TA 头上'); openOperatorPanel() }

  // 登录方式：老板最在意的一句话 —— 到底是"账号密码登录"还是"粘了个连接码"
  const lm = loginMethod()
  if (lm.byAccount) {
    const m = document.createElement('div')
    m.className = 'card'
    m.innerHTML = '<div class="flex" style="align-items:center;gap:11px">' +
      '<div style="width:34px;height:34px;border-radius:11px;background:var(--blue-l);color:var(--blue);display:flex;align-items:center;justify-content:center;flex:none">' + FiIcon('check', 18) + '</div>' +
      '<div style="flex:1;min-width:0"><div class="font-bold" style="font-size:13.5px">账号密码登录</div>' +
      '<div class="text-xs text-muted" style="margin-top:3px">' + escHtml(lm.account) + (lm.deviceToken ? ' · 店里换连接码会自动恢复' : '') + '</div></div></div>'
    app.appendChild(m)
  } else {
    const m = document.createElement('div')
    m.className = 'card'
    m.style.borderColor = '#f0dfb8'
    m.style.background = 'var(--warn-l)'
    m.innerHTML = '<div class="font-bold" style="font-size:13.5px;color:#8a6400">现在是用连接码接入的</div>' +
      '<div class="text-xs" style="margin-top:4px;color:#8a6400;line-height:1.6">没有走过账号密码。改成账号密码登录后：店里换过连接码手机能自动恢复，忘了密码还能找回。</div>' +
      '<button id="bind-acct" class="okbtn" style="margin-top:10px;height:42px;font-size:14px">用账号密码登录一次</button>'
    app.appendChild(m)
    m.querySelector('#bind-acct').onclick = function () { openLoginPanel(false, 'bind') }
  }

  // 分组渲染：一屏能扫完，不用在几十个入口里找
  // 分组可折叠：点标题收起/展开，状态记在本机（老板要"分类能缩放"）
  // 默认**全部展开**（老板反馈"进去更多时都是缩放着的" —— 收起来只剩四行标题，看着又空又小）。
  // 想收起点右边「收起」就行，状态记在本机；key 换到 v2，让旧的"全收起"记录不再生效。
  function collapsedGroups() {
    try {
      const raw = localStorage.getItem('fi-more-collapsed-v2')
      if (raw === null) return []          // 第一次进 / 老版本升级上来：全部展开
      return JSON.parse(raw || '[]')
    } catch (e) { return [] }
  }
  function toggleGroup(name, on) {
    try {
      const cur = collapsedGroups().filter(function (x) { return x !== name })
      if (on) cur.push(name)
      localStorage.setItem('fi-more-collapsed-v2', JSON.stringify(cur))
    } catch (e) { /* 存不住不致命 */ }
  }
  function block(title, rows) {
    const isCollapsed = collapsedGroups().indexOf(title) >= 0
    const g = document.createElement('div')
    g.className = 'group tap'
    // 右边给一个明确的「展开 / 收起」，别只放一个箭头（老板说"右边要有缩放按键或者提示才对"）
    g.innerHTML = '<span class="gr-t">' + escHtml(title) + '</span><span class="ln"></span>' +
      '<span class="gr-btn">' + (isCollapsed ? '展开' : '收起') + FiIcon('chevron', 13) + '</span>'
    g.style.cursor = 'pointer'
    app.appendChild(g)
    const list = document.createElement('div')
    list.className = 'list' + (isCollapsed ? ' collapsed' : '')
    rows.forEach(function (r) {
      const row = document.createElement('div')
      row.className = 'row'
      row.innerHTML =
        '<div class="ri ' + (r.tone || '') + '">' + FiIcon(r.icon, 18) + '</div>' +
        '<div class="rt"><div class="a"' + (r.danger ? ' style="color:var(--danger)"' : '') + '>' + escHtml(r.t) + '</div><div class="b">' + escHtml(r.d) + '</div></div>' +
        '<div class="ch">' + FiIcon('chevron', 16) + '</div>'
      row.onclick = r.fn
      list.appendChild(row)
    })
    app.appendChild(list)
    g.onclick = function () {
      const nowCollapsed = !list.classList.contains('collapsed')
      list.classList.toggle('collapsed', nowCollapsed)
      g.classList.toggle('closed', nowCollapsed)
      const btn = g.querySelector('.gr-btn')
      if (btn) btn.innerHTML = (nowCollapsed ? '展开' : '收起') + FiIcon('chevron', 13)
      toggleGroup(title, nowCollapsed)
    }
    if (isCollapsed) g.classList.add('closed')
  }

  block('经营', [
    { icon: 'sparkle', t: 'AI 助手', d: '问库存、要补货建议、经营问答', fn: () => navigate('ai') },
    { icon: 'chart', t: '今日盈利', d: '营业额 / 毛利 / 净利', fn: () => navigate('today') },
    { icon: 'alert', t: '补货清单', d: '低库存 + 补货建议', fn: () => navigate('restock') },
    { icon: 'clock', t: '临期预警', d: '快过期的批次，躺着也能看', fn: () => navigate('expiring') },
    { icon: 'trash', t: '报损登记', d: '破损 / 临期报废，手机记一笔', fn: () => navigate('waste') },
  ])
  block('货品', [
    { icon: 'clipboard', t: '核对货架', d: '每天核对一片区域', fn: () => navigate('stocktake') },
    { icon: 'box', t: '组合商品', d: '多商品打包，点开看明细', fn: () => navigate('kits') },
    { icon: 'tag', t: '配件清单', d: '配件 / 替换件', fn: () => navigate('parts') },
  ])
  block('账务', [
    { icon: 'users', t: '客户欠款', d: '赊账查询与收款', fn: () => navigate('customers') },
    { icon: 'receipt', t: '收款登记', d: '实收登记 + 和营业额对账', fn: () => navigate('receipts') },
    { icon: 'wallet', t: '支出记账', d: '记一笔房租 / 水电 / 进货', fn: () => navigate('expenses') },
    { icon: 'truck', t: '供应商', d: '进货对账', fn: () => navigate('suppliers') },
  ])

  const sys = [
    { icon: 'sparkle', t: '使用引导', d: '五步讲清楚这个 APP 怎么用（第一次打开会自动弹）', fn: function () { openGuide(true) } },
    { icon: 'share', t: '分享给同事', d: '把下载链接发微信，别人也能装', fn: shareApp },
    { icon: 'pulse', t: '使用情况', d: '装了几台、今天几台在用、版本分布', fn: openUsagePanel },
    { icon: 'type', t: '界面字号', d: '小 / 标准 / 大，整套一起变', fn: openSizeSheet },
    { icon: 'pulse', t: '屏幕适配自检', d: '功能栏没贴底 / 有空白时，点这里看实测尺寸', fn: openScreenDiag },
    { icon: 'camera', t: '图片同步自检', d: '这台手机拍的照片别的手机看不到时，点这里看卡在哪一环', fn: openPhotoSyncDiag },
    { icon: 'refresh', t: '更新说明', d: '当前 ' + (WEB_VERSION_APPLIED || APP_VERSION) + ' · 最近几版改了什么', fn: openUpdateHistory },
    { icon: 'users', t: '反馈给开发', d: '哪里不对 / 想加什么，直接说；会自动带上页面和版本', fn: openFeedbackSheet },
    { icon: 'receipt', t: '我的反馈' + (fiUnseenReplies() ? ' ●' + fiUnseenReplies() : ''), d: fiReplyCount() ? ('我们回了 ' + fiReplyCount() + ' 条') : '看我们回了什么', fn: openMyFeedbackSheet },
    { icon: 'clock', t: '每日提醒', d: '每天定时把「今天该做的事」发到你微信上', fn: openNotifySheet },
    { icon: 'undo', t: '撤回误操作', d: '删商品 / 报损 / 入库点错了能还原', fn: openUndoPanel },
  ]
  if (SERVER) {
    sys.push({ icon: 'refresh', t: '检查更新', d: '页面 ' + (WEB_VERSION_APPLIED || APP_VERSION) + (WEB_USING_BUNDLE ? '（热更）' : '（安装包自带）') + ' · 壳 ' + APP_VERSION, fn: () => checkAllUpdates(false) })
    if (WEB_USING_BUNDLE) {
      sys.push({ icon: 'download', t: '回退到安装包版本', d: '当前跑的是热更包 ' + (WEB_VERSION_APPLIED || '') + '，点这里换回自带版本', fn: function () {
        const WU = webUpdaterPlugin()
        if (!WU) return
        if (!confirm('回退到安装包自带的版本（' + APP_VERSION + '）？回退后下次有新版本还会自动热更。')) return
        WU.rollback().then(function () { toast('已回退，正在重开…') }).catch(function () { toast('回退失败，请重开 APP 再试') })
      } })
    }
  }
  sys.push({ icon: 'link', t: '账号与连接', d: loginMethod().byAccount ? ('账号密码登录 · ' + loginMethod().account) : '连接码接入 · 可改成账号密码', fn: () => openConnectPanel() })
  block('系统', sys)

  const out = document.createElement('div')
  out.className = 'list'
  out.style.marginBottom = '6px'
  out.innerHTML = '<div class="row"><div class="ri red">' + FiIcon('logout', 18) + '</div>' +
    '<div class="rt"><div class="a" style="color:var(--danger)">退出登录</div><div class="b">换人或换店铺时用；退出不会动账本里的数据</div></div></div>'
  out.querySelector('.row').onclick = logoutNow
  app.appendChild(out)

  const note = document.createElement('div')
  note.className = 'note'
  note.textContent = '采购订货、经营报表、批量导入、设置请在电脑上操作'
  app.appendChild(note)
})

// 收款登记（v3.0）：微信/支付宝/现金实收登记 + 日结对账（不用翻支付账单）
function openReceiptPanel() {
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.95);z-index:300;display:flex;flex-direction:column;padding:20px;color:#e6edf5;overflow:auto'
  const todayStr = () => {
    const d = new Date()
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }
  overlay.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<div style="font-size:20px;font-weight:700">' + FiIcon('receipt', 18) + ' 收款对账</div>' +
      '<button id="rec-close" style="width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:20px">' + FiIcon('close', 16) + '</button>' +
    '</div>' +
    '<div style="margin-bottom:12px"><input type="date" id="rec-date" value="' + todayStr() + '" style="width:100%;height:46px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:10px;color:#fff;font-size:16px;padding:0 12px"></div>' +
    '<div id="rec-sum" style="margin-bottom:12px"></div>' +
    '<div id="rec-form" style="flex:1"></div>' +
    '<button id="rec-save" style="height:54px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:18px;font-weight:800">保存登记</button>'
  document.body.appendChild(overlay)
  document.getElementById('rec-close').onclick = () => overlay.remove()

  const METHODS = ['现金', '微信', '支付宝', '其他']
  const MI = { 现金: 'wallet', 微信: 'phone', 支付宝: 'bolt', 其他: 'receipt' }
  const fmt = (fen) => '¥' + (fen / 100).toFixed(2)
  const dateEl = document.getElementById('rec-date')
  const sumEl = document.getElementById('rec-sum')
  const formEl = document.getElementById('rec-form')
  const inputs = {}

  async function load() {
    const date = dateEl.value
    let recon = null
    try { recon = await api('receipt:reconcile', { date }) } catch (e) {}
    if (recon) {
      const diff = Math.abs(recon.difference) < 0.5
      sumEl.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
          '<div style="background:rgba(255,255,255,.08);border-radius:10px;padding:12px"><div style="font-size:12px;color:#8fa3c0">应收(营业额)</div><div style="font-size:20px;font-weight:800">' + fmt(recon.revenue) + '</div></div>' +
          '<div style="background:rgba(74,222,128,.12);border-radius:10px;padding:12px"><div style="font-size:12px;color:#8fa3c0">实收登记</div><div style="font-size:20px;font-weight:800;color:#4ade80">' + fmt(recon.totalReceived) + '</div></div>' +
          '<div style="background:rgba(251,191,36,.12);border-radius:10px;padding:12px"><div style="font-size:12px;color:#8fa3c0">赊账未收</div><div style="font-size:20px;font-weight:800;color:#fbbf24">' + fmt(recon.credit) + '</div></div>' +
          '<div style="background:' + (diff ? 'rgba(74,222,128,.12)' : 'rgba(248,113,113,.15)') + ';border-radius:10px;padding:12px"><div style="font-size:12px;color:#8fa3c0">差异</div><div style="font-size:20px;font-weight:800;color:' + (diff ? '#4ade80' : '#f87171') + '">' + (diff ? '账平 ✓' : fmt(recon.difference)) + '</div></div>' +
        '</div>'
    }
    // 登记表单：4 个方式
    let rows = ''
    for (const m of METHODS) {
      const cur = recon && recon.byMethod && recon.byMethod[m] ? (recon.byMethod[m] / 100).toFixed(2) : ''
      rows +=
        '<div style="display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,.06);border-radius:10px;padding:10px 12px;margin-bottom:8px">' +
          '<div style="font-size:16px;font-weight:600">' + (MI[m] ? FiIcon(MI[m], 15) : '') + ' ' + m + '</div>' +
          '<input id="rec-in-' + m + '" type="number" step="0.01" min="0" placeholder="' + (cur || '实收金额') + '" value="' + cur + '" style="width:120px;height:40px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:#fff;font-size:15px;text-align:right;padding:0 8px">' +
        '</div>'
    }
    formEl.innerHTML = rows
    for (const m of METHODS) inputs[m] = document.getElementById('rec-in-' + m)
  }

  dateEl.onchange = load
  document.getElementById('rec-save').onclick = async () => {
    try {
      for (const m of METHODS) {
        const v = inputs[m].value
        const cents = Math.round(parseFloat(v || '0') * 100)
        if (Number.isFinite(cents) && cents >= 0) {
          await api('receipt:register', { date: dateEl.value, method: m, amount: cents, operator: getOperator() })
        }
      }
      toast('已保存，对账已更新')
      await load()
    } catch (e) { toast('保存失败：' + e.message) }
  }
  load()
}


// 注意：不能在文件末尾直接调 renderPage()——此时 pages/*.js 还没加载，
// pages 是空的，会把首页渲染成"页面未找到"且锁死 currentPage。
// 首页渲染交给 DOMContentLoaded（此时所有脚本已执行完）。