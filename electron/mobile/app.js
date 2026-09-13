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
const COLORS = ["#0e9f6e","#b7791f","#1677ff","#7c3aed","#d64545","#0e7490","#be185d","#3f6212","#9a3412"]

// 防请求风暴：只有连接码失效(401)才全局标记锁死（横幅会引导到「更多 - 连接设置」重输）；
// 普通网络抖动（断网/超时）不锁死，让单次请求失败后可以重试——否则 WiFi 一抖手机端就全瘫
let tokenFailed = false
const READ_TIMEOUT_MS = 8000  // 读操作：8 秒足够，再久用户就以为卡死了
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
  'inbound:create': 1, 'outbound:confirm': 1, 'outbound:checkout': 1, 'outbound:return': 1, 'outbound:exchange': 1,
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
    const timer = setTimeout(function () { controller.abort() }, WRITE_CHANNELS[channel] ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS)
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
    if (r.status === 401) { tokenFailed = true; showNetBanner('连接已失效，点这里重新输入连接码', '#ffdede', function () { openConnectPanel() }); throw new Error(data.error || '连接已失效，请到「更多 - 连接设置」重新输入连接码') }
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
const NO_CACHE = { 'ai:chat': 1, 'ai:dailySummary': 1, 'ai:photoDraft': 1, 'payment:getQr': 1 }
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
  if (tokenFailed) throw new Error('连接已失效，请到「更多 - 连接设置」重新输入连接码')
  if (!TOKEN) throw new Error('还没连上店铺账本，请到「更多 - 连接设置」填入连接码')
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
function openConnectPanel(firstRun) {
  const old = document.getElementById('cn-panel'); if (old) old.remove()
  const ov = document.createElement('div')
  ov.id = 'cn-panel'
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.97);z-index:300;padding:22px;color:#e6edf5;overflow:auto'
  ov.innerHTML =
    '<div style="font-size:22px;font-weight:800;margin-bottom:6px">连接店铺账本</div>' +
    '<div style="font-size:14px;color:#8fa3c0;line-height:1.75;margin-bottom:16px">把店主发给你的<b style="color:#d4af37">连接码</b>粘进来就行。<br>整条链接（https://…）直接粘进来也能认。</div>' +
    '<input id="cn-in" placeholder="在这里粘贴连接码" autocomplete="off" spellcheck="false" style="width:100%;height:60px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);border-radius:12px;color:#fff;font-size:17px;padding:0 14px;outline:none">' +
    '<div id="cn-echo" style="font-size:13px;color:#8fa3c0;margin:8px 0 14px;min-height:18px"></div>' +
    '<div style="display:flex;gap:10px;margin-bottom:12px">' +
      '<button id="cn-paste" style="flex:1;height:52px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px;font-weight:700">粘贴</button>' +
      '<button id="cn-scan" style="flex:1;height:52px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px;font-weight:700">扫码</button>' +
    '</div>' +
    '<button id="cn-go" style="width:100%;height:60px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:19px;font-weight:800">连接</button>' +
    '<button id="cn-off" style="width:100%;height:50px;margin-top:12px;border-radius:12px;border:none;background:rgba(248,113,113,.18);color:#ffd9d9;font-size:15px">断开本机连接</button>' +
    '<div style="font-size:12px;color:#8fa3c0;margin-top:14px;line-height:1.8">当前：' + (TOKEN ? '已连接' : '还没连接') + '<br>连接码在店主那台电脑上，或让店主发你一条链接。' +
    (firstRun ? '<br><br>连上以后，开单、查库存、看今天赚多少都能用。' : '') + '</div>' +
    (SERVER ? '<button id="cn-up" style="width:100%;height:44px;margin-top:12px;border-radius:12px;border:none;background:rgba(255,255,255,.08);color:#b9c8dd;font-size:14px">🔄 检查更新（当前 ' + APP_VERSION + '）</button>' : '')
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
  const upBtn = ov.querySelector('#cn-up')   // 还没连上时的更新入口（1.1.2 起；浏览器页面没有这个按钮）
  if (upBtn) upBtn.onclick = function () { checkUpdate(false) }
  ov.querySelector('#cn-off').onclick = function () {
    try { localStorage.removeItem('fi-mobile-token'); localStorage.removeItem('fi-server') } catch (e) {}
    toast('已断开，重开 APP 再连一次')
    setTimeout(function () { location.reload() }, 600)
  }
  refresh()
  setTimeout(function () { inp.focus() }, 150)
}
// 断网自动提示 + 恢复自动隐藏（T4）
window.addEventListener('offline', () => showNetBanner('网络已断开，请检查手机网络', '#ffe9d6', () => { hideNetBanner(); renderPage(true) }))
window.addEventListener('online', () => { hideNetBanner(); flushOffline(); renderPage(true) })

let currentPage = ''
let renderGen = 0 // 页面代次：切页后旧请求的续写一律丢弃，避免把上一页的数据写进新页面
function navigate(hash) { location.hash = hash }
window.addEventListener('hashchange', () => renderPage())
document.addEventListener('DOMContentLoaded', () => {
  // 更新检查**不依赖「是否已连上」**：卡在连接面板的机器也要能收到新版本（1.1.2 修）。
  // 仍然只对装了 APP 的机器生效（SERVER 有值），浏览器 / 局域网 /m/ 直接跳过。
  setTimeout(function () { checkUpdate(true) }, 3000)
  // 没有连接码：用页内面板（可粘整条链接 / 扫码），不再用系统弹窗 —— 店主不会打长串；
  // 官网 / 局域网 /m/ 也一样走这里（粘连接码即可，SERVER 留空=同源）。
  if (!TOKEN) { openConnectPanel(true); return }
  document.getElementById('dateEl').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  renderPage()
  flushOffline() // 开机先把上次离线攒下的单据重传一遍
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
  app.innerHTML = '<div class="text-center" style="padding:40px;color:var(--sub)">加载中...</div>'
  const fn = pages[page]
  if (fn) { try { fn(app) } catch (e) { app.innerHTML = '<div class="text-center" style="padding:40px"><div style="font-size:48px">⚠️</div><div class="text-red font-bold mt">' + page + ' 出错</div><div class="text-sm text-muted mt-sm">' + e.message + '</div></div>' } }
  else if (LAZY_PAGES[page]) {
    // 低频页：首次进入时才去取脚本；离线且缓存里还没有 → 明确告知，不假装加载中
    loadPageScript(page).then(function (ok) {
      if (currentPage !== page) return
      const f2 = pages[page]
      if (f2) { try { app.innerHTML = ''; f2(app) } catch (e) { app.innerHTML = '<div class="text-center" style="padding:40px"><div class="text-red font-bold mt">' + page + ' 出错</div><div class="text-sm text-muted mt-sm">' + e.message + '</div></div>' } }
      else { app.innerHTML = '<div class="text-center" style="padding:40px"><div class="font-bold mt">这一页还没下载好</div><div class="text-sm text-muted mt-sm">连一次网打开它，之后离线也能用</div></div>' }
    })
  }
  else { app.innerHTML = '<div class="text-center" style="padding:40px"><div style="font-size:48px">⚠️</div><div class="font-bold mt">页面未找到</div></div>' }
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

function phColor(p) { return COLORS[(p.id || 0) % COLORS.length] }
function phChar(p) { const name = (((p.brand || '') + ' ' + (p.model || '')).trim() || p.sku_code || ''); return name[0] || '?' }
function prodName(p) { const n = ((p.brand || '') + ' ' + (p.model || '')).trim(); return (n || p.sku_code || '未知') }

// ========== 应用内更新（只对 APK 生效；浏览器 /m/ 页面不弹）==========
// 版本号必须与 android/app/build.gradle 的 versionCode/versionName 一致 ——
// 有 scripts/check-version-sync.mjs 强制校验，发版前必跑（否则会重演「版本号三处不一致、更新永远是哑的」）。
const APP_VERSION = 'v1.1.2'
const APP_VERSION_CODE = 1102
const UPDATE_BASE = 'http://43.128.20.39:17533'

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
    '<div style="font-size:13px;color:#8fa3c0;margin-bottom:14px">当前 ' + escHtml(APP_VERSION) + '</div>'
  if (meta.changelog) h += '<div style="font-size:14px;line-height:1.8;color:#c7d2e0;background:rgba(255,255,255,.06);border-radius:10px;padding:12px;margin-bottom:14px">' + escHtml(meta.changelog) + '</div>'
  h += '<button id="up-go" style="width:100%;height:60px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:19px;font-weight:800">下载更新</button>' +
    '<button id="up-no" style="width:100%;height:50px;margin-top:10px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px">稍后再说</button>'
  ov.innerHTML = h
  document.body.appendChild(ov)
  ov.querySelector("#up-go").onclick = function () { ov.remove(); doDownloadUpdate(meta) }
  ov.querySelector("#up-no").onclick = function () { ov.remove() }
}

// 手动检查：silent=false 时会给出「已是最新版 / 连不上」反馈
function checkUpdate(silent) {
  if (!SERVER) return            // 浏览器/局域网页面没有安装包可更新
  if (!silent) toast("正在检查更新…")
  fetchUpdateManifest().then(function (m) {
    if (!m) { if (!silent) toast("连不上更新服务器，请稍后再试"); return }
    if (m.versionCode > APP_VERSION_CODE) askUpdate(m)
    else if (!silent) toast("已是最新版 " + APP_VERSION)
  })
}
// ========== 扫码 ==========
let scanCallback = null

// 扫码面板：手动输入 + 拍照识别双入口。
// 手动输入是主路径（准确），拍照识别是快捷辅助（条码清晰时可用）。
// 不依赖 getUserMedia（局域网 HTTP 非安全环境会禁用摄像头扫码）。
function openScanner(cb, hint) {
  scanCallback = cb
  const overlay = document.createElement('div')
  overlay.id = 'scan-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.95);z-index:300;display:flex;flex-direction:column;justify-content:center;padding:24px;color:#e6edf5'
  overlay.innerHTML =
    '<div style="font-size:18px;font-weight:700;margin-bottom:8px">扫码 / 输条码</div>' +
    '<div style="font-size:13px;color:#8fa3c0;margin-bottom:14px">' + (hint || '扫描或输入商品条码') + '</div>' +
    '<input id="scan-input" type="text" placeholder="输入条码数字" style="height:56px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.25);border-radius:12px;color:#fff;font-size:20px;padding:0 14px;margin-bottom:12px;width:100%;outline:none">' +
    '<div style="display:flex;gap:10px">' +
      '<button id="scan-ok" style="flex:1;height:54px;border-radius:12px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:17px;font-weight:800">确认</button>' +
      '<button id="scan-cam" style="flex:1;height:54px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:17px">📷 拍照识别</button>' +
    '</div>' +
    '<button id="scan-cancel" style="margin-top:12px;height:44px;border-radius:10px;border:none;background:transparent;color:#8fa3c0;font-size:15px">取消</button>'
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

  // 自动聚焦手动输入框
  setTimeout(() => { const i = document.getElementById('scan-input'); if (i) i.focus() }, 100)
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
const LAZY_PAGES = { ai: 1, restock: 1, expiring: 1, waste: 1, kits: 1, customers: 1, expenses: 1, suppliers: 1, stocktake: 1, parts: 1 }
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

page('more', (app) => {
  app.innerHTML = ''
  // 当前操作员：放最上面，换人点一下 —— 多人共用一台手机时这是每天都会用到的
  const opCard = document.createElement('div')
  opCard.className = 'card'; opCard.style.cursor = 'pointer'; opCard.onclick = openOperatorPanel
  opCard.innerHTML = '<div class="font-bold">👤 当前操作员：' + escHtml(getOperator()) + '</div><div class="text-sm text-muted mt-sm">换人点这里 · 开单/入库/报损都记在这个名字上</div>'
  app.appendChild(opCard)
  const items = [
    ['🤖 AI 助手', '问库存、要补货建议、经营问答', () => navigate('ai')],
    ['💰 今日盈利', '营业额/毛利/净利，今天赚了多少', () => navigate('today')],
    ['⚠️ 补货清单', '低库存 + 补货建议', () => navigate('restock')],
    ['⏰ 临期预警', '快过期的批次，躺着也能看', () => navigate('expiring')],
    ['🗑️ 报损登记', '破损/临期报废，手机记一笔', () => navigate('waste')],
        ['📦 组合商品', '多商品打包，点开看明细', () => navigate('kits')],
    ['👤 客户欠款', '赊账查询与收款', () => navigate('customers')],
    ['💸 支出记账', '记一笔房租/水电/进货', () => navigate('expenses')],
    ['🏭 供应商', '进货对账', () => navigate('suppliers')],
    ['💳 收款登记', '微信/支付宝/现金实收登记 + 日结对账', () => openReceiptPanel()],
    ['📋 核对货架', '每天核对一片区域', () => navigate('stocktake')],
  ]
  items.forEach(([t, d, fn]) => {
    const card = document.createElement('div')
    card.className = 'card'; card.style.cursor = 'pointer'; card.onclick = fn
    card.innerHTML = '<div class="font-bold">' + t + '</div><div class="text-sm text-muted mt-sm">' + d + '</div>'
    app.appendChild(card)
  })
  if (SERVER) {   // APK 才显示：浏览器页面点它没有意义
    const upCard = document.createElement('div')
    upCard.className = 'card'; upCard.style.cursor = 'pointer'; upCard.onclick = function () { checkUpdate(false) }
    upCard.innerHTML = '<div class="font-bold">🔄 检查更新</div><div class="text-sm text-muted mt-sm">当前 ' + APP_VERSION + ' · 有新版本会提示下载</div>'
    app.appendChild(upCard)
  }
  const connCard = document.createElement('div')
  connCard.className = 'card'; connCard.style.cursor = 'pointer'; connCard.onclick = function () { openConnectPanel() }
  connCard.innerHTML = '<div class="font-bold">🔗 连接设置</div><div class="text-sm text-muted mt-sm">' + (TOKEN ? '已连接店铺账本' : '还没连接') + ' · 换店铺或重新输入连接码' + '</div>'
  app.appendChild(connCard)
  const note = document.createElement('div')
  note.className = 'text-center text-sm text-muted'; note.style.padding = '20px'
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
      '<div style="font-size:20px;font-weight:700">💳 收款对账</div>' +
      '<button id="rec-close" style="width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:20px">✕</button>' +
    '</div>' +
    '<div style="margin-bottom:12px"><input type="date" id="rec-date" value="' + todayStr() + '" style="width:100%;height:46px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:10px;color:#fff;font-size:16px;padding:0 12px"></div>' +
    '<div id="rec-sum" style="margin-bottom:12px"></div>' +
    '<div id="rec-form" style="flex:1"></div>' +
    '<button id="rec-save" style="height:54px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:18px;font-weight:800">保存登记</button>'
  document.body.appendChild(overlay)
  document.getElementById('rec-close').onclick = () => overlay.remove()

  const METHODS = ['现金', '微信', '支付宝', '其他']
  const EMOJI = { 现金: '💵', 微信: '💚', 支付宝: '🅰️', 其他: '📒' }
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
          '<div style="font-size:16px;font-weight:600">' + (EMOJI[m] || '') + ' ' + m + '</div>' +
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