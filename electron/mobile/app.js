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

// 防请求风暴：只有 token 失效(401)才全局标记锁死（等用户回设置页重新扫码）；
// 普通网络抖动（断网/超时）不锁死，让单次请求失败后可以重试——否则 WiFi 一抖手机端就全瘫
let tokenFailed = false
const REQUEST_TIMEOUT_MS = 15000 // 15 秒超时，不无限等

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

// 协议检测：https=语音可用；http=语音受限（提示重新扫 https 码）
;(function checkProtocol() {
  if (location.protocol === 'http:') {
    showNetBanner('当前是普通连接，语音识别用不了。回店里电脑设置页重新扫码（安全连接），或用电脑说话。')
  }
})()

let netDown = false
async function api(channel, payload) {
  if (tokenFailed) throw new Error('连接已失效，请回设置页重新扫码')
  if (!TOKEN) throw new Error('未连接电脑，请回到设置页扫码进入手机端')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let r
  try {
    r = await fetch(SERVER + '/api/invoke?token=' + TOKEN, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, payload: payload || {} }),
      signal: controller.signal,
    })
  } catch (e) {
    // 断网/超时：显示断网提示+重试 横幅，不锁死全局，仅本次失败
    showNetBanner('连不上中心库 / 网络异常，检查网络后重试', '#ffe9d6', () => { hideNetBanner(); renderPage() })
    netDown = true
    throw new Error(e?.name === 'AbortError' ? '请求超时，请重试' : '连不上中心库，请检查手机网络')
  } finally {
    clearTimeout(timer)
  }
  const data = await r.json()
  if (netDown && r.ok) { netDown = false; if (location.protocol !== 'http:') hideNetBanner() }
  if (!r.ok) {
    if (r.status === 401) tokenFailed = true // token 失效，停止所有后续请求（需重新扫码）
    throw new Error(data.error || '请求失败')
  }
  return data.result
}

// —— 操作员身份（T2 统一）：全手机页写操作共用同一个 getOperator()，发货/开单/入库/报损都能追到人 ——
function getOperator() { try { return localStorage.getItem('fi-operator') || '老板' } catch { return '老板' } }
function setOperator(n) { try { localStorage.setItem('fi-operator', String(n == null ? '' : n).trim() || '老板') } catch {} }
// 断网自动提示 + 恢复自动隐藏（T4）
window.addEventListener('offline', () => showNetBanner('网络已断开，请检查手机网络', '#ffe9d6', () => { hideNetBanner(); renderPage() }))
window.addEventListener('online', () => { hideNetBanner(); renderPage() })

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
function phChar(p) { const name = (((p.brand || '') + ' ' + (p.model || '')).trim() || p.sku_code || ''); return name[0] || '?' }
function prodName(p) { const n = ((p.brand || '') + ' ' + (p.model || '')).trim(); return (n || p.sku_code || '未知') }

// ========== 语音识别（40岁+用户：打字慢，按住/点按说话最自然） ==========
// 链路：手机录音(webm) → 本地转16kHz PCM → 发给PC本地识别(sherpa-onnx)
//       本地模型没下载 → 兜底云端ASR(webm base64)
let mediaRecorder = null
let mediaChunks = []

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.readAsDataURL(blob)
  })
}

// webm → 16kHz 单声道 Float32 PCM（本地 sherpa-onnx 需要的输入）
async function blobToPcm16k(blob) {
  const buf = await blob.arrayBuffer()
  const Ctx = window.AudioContext || window.webkitAudioContext
  const ctx = new Ctx()
  try {
    const decoded = await ctx.decodeAudioData(buf)
    const targetLen = Math.max(1, Math.ceil(decoded.duration * 16000))
    const off = new OfflineAudioContext(1, targetLen, 16000)
    const src = off.createBufferSource()
    src.buffer = decoded
    src.connect(off.destination)
    src.start()
    const rendered = await off.startRendering()
    return Array.from(rendered.getChannelData(0)) // 转普通数组便于 JSON 传输
  } finally { ctx.close().catch(() => {}) }
}

// 语音转文字：本地 sherpa → 豆包ASR（火山方舟）→ Kimi，逐级降级
async function speechToText(blob) {
  const b64 = await blobToBase64(blob)
  // 1) 本地 sherpa-onnx（离线、免费、快；小模型识别一般）
  try {
    const status = await api('voice:status')
    if (status && status.ready) {
      const pcm = await blobToPcm16k(blob)
      if (pcm.length > 0) {
        const r = await api('voice:transcribe', { pcm, sampleRate: 16000 })
        if (r && r.ok && r.text) return { text: r.text, mode: '本地' }
      }
    }
  } catch { /* 本地失败 → 走豆包 */ }
  // 2) 豆包 ASR（火山方舟，中文识别更准；需电脑配了豆包 Key）
  try {
    const r = await api('doubao:transcribe', { audioBase64: b64, mimeType: 'audio/webm' })
    if (r && r.ok && r.text) return { text: r.text, mode: '豆包' }
  } catch { /* 豆包失败 → 走 Kimi */ }
  // 3) Kimi whisper（兜底）
  try {
    const r = await api('ai:transcribe', { audioBase64: b64, mimeType: 'audio/webm' })
    if (r && r.ok && r.text) return { text: r.text, mode: '云端' }
  } catch { /* 都失败 */ }
  return null
}

// 语音输入弹层：大麦克风按钮，点一下开始听、再点一下结束并识别
function voiceInput(onResult, hint) {
  // 浏览器麦克风需要 HTTPS/localhost 安全上下文；局域网 HTTP 下 navigator.mediaDevices 是 undefined
  // 这里提前拦截，不弹录音界面也不报错，提示用打字或电脑上软件的语音
  const hasMic = !!(window.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  if (!hasMic) {
    toast('这个网络不支持手机录音（要用语音请连 HTTPS 或直接在电脑上说话）')
    return
  }
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.96);z-index:400;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#e6edf5'
  overlay.innerHTML =
    '<div style="font-size:20px;font-weight:800;margin-bottom:6px">语音输入</div>' +
    '<div style="font-size:14px;color:#8fa3c0;margin-bottom:30px">' + (hint || '点一下麦克风开始说，再说一次结束') + '</div>' +
    '<div id="voice-mic" style="width:130px;height:130px;border-radius:50%;background:linear-gradient(135deg,#c9a55a,#d4af37);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 30px rgba(212,175,55,.4)">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="#0a1628" stroke-width="2" width="56" height="56"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM5 10a7 7 0 0 0 14 0M12 17v4"/></svg>' +
    '</div>' +
    '<div id="voice-status" style="margin-top:24px;font-size:16px;color:#8fa3c0">点麦克风开始</div>' +
    '<button id="voice-close" style="margin-top:30px;height:48px;padding:0 30px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px">取消</button>'
  document.body.appendChild(overlay)

  let recording = false
  let startTime = 0
  const micBtn = overlay.querySelector('#voice-mic')
  const statusEl = overlay.querySelector('#voice-status')

  // 语音搜索：ASR 识别出的词先用店里商品清单纠错，再回调（识别不准时纠正成真实商品名）
  async function smartVoiceSearch(rawText, onResult) {
    const text = (rawText || '').trim()
    if (!text) { onResult(''); return }
    let finalText = text
    let hint = ''
    try {
      const r = await api('ai:correctTerm', { text })
      if (r && r.ok && r.corrected && r.matched) {
        finalText = r.corrected
        hint = '已纠正「' + text + '」→「' + r.corrected + '」'
      }
    } catch { /* 纠错失败就用原词 */ }
    if (hint) toast(hint)
    onResult(finalText)
  }

  function startRecording() {
    if (!window.navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusEl.textContent = '此网络不支持录音，请关掉用打字'
      return
    }
    mediaChunks = []
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      mediaRecorder = new MediaRecorder(stream)
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) mediaChunks.push(e.data) }
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(mediaChunks, { type: 'audio/webm' })
        const secs = ((Date.now() - startTime) / 1000).toFixed(0)
        statusEl.textContent = '识别中（' + secs + '秒）...'
        const res = await speechToText(blob)
        overlay.remove()
        if (res && res.text) { onResult(res.text, res.mode) }
        else { toast('没听清，再说一次或直接打字'); onResult('', '') }
      }
      mediaRecorder.start()
      recording = true
      startTime = Date.now()
      statusEl.textContent = '正在听... 再说一次结束'
      micBtn.style.background = 'linear-gradient(135deg,#e74c3c,#c0392b)'
      micBtn.querySelector('svg').style.stroke = '#fff'
    }).catch(() => { toast('无法使用麦克风，请直接打字'); overlay.remove() })
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop()
      mediaRecorder = null
    }
  }

  micBtn.onclick = () => { if (recording) { recording = false; stopRecording() } else { startRecording() } }
  overlay.querySelector('#voice-close').onclick = () => { if (recording) { try { mediaRecorder && mediaRecorder.stop() } catch {} } overlay.remove() }
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

// ========== 页面注册 ==========
const pages = {}
function page(name, fn) { pages[name] = fn }

page('more', (app) => {
  app.innerHTML = ''
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
