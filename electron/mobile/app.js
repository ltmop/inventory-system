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
const SERVER = ''
const COLORS = ["#0e9f6e","#b7791f","#1677ff","#7c3aed","#d64545","#0e7490","#be185d","#3f6212","#9a3412"]

// 防请求风暴：token 失效(401)或断网后全局标记，后续请求直接失败不再刷服务器
let tokenFailed = false
async function api(channel, payload) {
  if (tokenFailed) throw new Error('连接已失效，请回设置页重新扫码')
  if (!TOKEN) throw new Error('未连接电脑，请回到设置页扫码进入手机端')
  let r
  try {
    r = await fetch(SERVER + '/api/invoke?token=' + TOKEN, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, payload: payload || {} }),
    })
  } catch (e) {
    // 断网/网络错误：标记一次，避免页面疯狂重试把服务器或手机拖垮
    tokenFailed = true
    throw new Error('连不上电脑，检查店里 WiFi 是否正常')
  }
  const data = await r.json()
  if (!r.ok) {
    if (r.status === 401) tokenFailed = true // token 失效，停止所有后续请求
    throw new Error(data.error || '请求失败')
  }
  return data.result
}

let currentPage = ''
function navigate(hash) { location.hash = hash }
window.addEventListener('hashchange', renderPage)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('dateEl').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  renderPage()
})

function renderPage() {
  const hash = (location.hash || '#pos').replace('#', '')
  const page = hash || 'pos'
  if (page === currentPage) return
  currentPage = page
  document.querySelectorAll('.tab').forEach(a => {
    a.classList.toggle('on', a.getAttribute('href') === '#' + page)
  })
  const app = document.getElementById('app')
  app.innerHTML = '<div class="text-center" style="padding:40px;color:var(--sub)">加载中...</div>'
  const fn = pages[page]
  if (fn) { try { fn(app) } catch (e) { app.innerHTML = '<div class="text-center" style="padding:40px"><div style="font-size:48px">⚠️</div><div class="text-red font-bold mt">' + page + ' 出错</div><div class="text-sm text-muted mt-sm">' + e.message + '</div></div>' } }
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
function phChar(p) { const name = (p.brand || '') + (p.model || '') || p.sku_code || ''; return name[0] || '?' }
function prodName(p) { return (p.brand || '') + ' ' + (p.model || '') || p.sku_code || '未知' }

// ========== 扫码 ==========
let scanCallback = null

// 扫码：拍照解析条码。用 <input capture> 调起相机拍照，再本地解析——
// 不依赖 getUserMedia（局域网 HTTP 非安全环境会禁用摄像头扫码），店里 WiFi 下也能用。
function openScanner(cb, hint) {
  scanCallback = cb
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
          if (code && scanCallback) { closeScanner(); scanCallback(code) }
          else manualFallback('没识别出条码，手动输一下')
        } catch (e) { manualFallback('识别失败，手动输一下') }
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  }
  input.click()
}

async function decodeBarcode(img) {
  // 优先浏览器原生 BarcodeDetector（Chrome 支持，能解析图片）
  if ('BarcodeDetector' in window) {
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code'] })
    const codes = await detector.detect(img)
    if (codes.length > 0) return codes[0].rawValue
  }
  // 兜底：本地 zxing 解析（离线打包，不依赖网络/安全上下文）
  if (window.ZXing) {
    const reader = new ZXing.BrowserMultiFormatReader()
    const result = await reader.decodeFromImageElement(img)
    return result ? result.getText() : null
  }
  throw new Error('no decoder')
}

function manualFallback(hint) {
  const v = prompt(hint || '请输入条码')
  if (v && scanCallback) { closeScanner(); scanCallback(v) }
}

function closeScanner() {
  scanCallback = null
}

// ========== 页面注册 ==========
const pages = {}
function page(name, fn) { pages[name] = fn }

page('more', (app) => {
  app.innerHTML = ''
  const items = [
    ['💰 今日盈利', '营业额/毛利/净利，今天赚了多少', () => navigate('today')],
    ['⚠️ 补货清单', '低库存 + 补货建议', () => navigate('restock')],
    ['⏰ 临期预警', '饵料/小药快过期，躺着也能看', () => navigate('expiring')],
    ['🗑️ 报损登记', '活饵死亡/饵料报废，手机记一笔', () => navigate('waste')],
    ['🧰 套装', '新手套装/绑钩套装，点开看明细', () => navigate('kits')],
    ['👤 客户欠款', '赊账查询与收款', () => navigate('customers')],
    ['💸 支出记账', '记一笔房租/水电/进货', () => navigate('expenses')],
    ['💳 收款登记', '微信/支付宝/现金实收登记 + 日结对账', () => openReceiptPanel()],
    ['🏭 供应商', '进货对账', () => navigate('suppliers')],
    ['📋 核对货架', '每天核对一片区域', () => navigate('stocktake')],
  ]
  items.forEach(([t, d, fn]) => {
    const card = document.createElement('div')
    card.className = 'card'; card.style.cursor = 'pointer'; card.onclick = fn
    card.innerHTML = '<div class="font-bold">' + t + '</div><div class="text-sm text-muted mt-sm">' + d + '</div>'
    app.appendChild(card)
  })
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
          await api('receipt:register', { date: dateEl.value, method: m, amount: cents, operator: '手机' })
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
