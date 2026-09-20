// Service Worker：离线缓存手机页 —— 打开秒出、断网不白屏。
// 路径全部相对 SW 自身：官网是 /m/sw.js（BASE=/m/），APK 是 /sw.js（BASE=/），同一份代码两端通吃。
const BASE = new URL('./', self.location).pathname
const CACHE = 'ai-jxc-v1.0.12'
const ASSETS = [
  BASE, BASE + 'index.html', BASE + 'app.js', BASE + 'offline.js', BASE + 'manifest.json',
  BASE + 'pages/pos.js', BASE + 'pages/inbound.js', BASE + 'pages/stock.js', BASE + 'pages/today.js',
  BASE + 'pages/expiring.js', BASE + 'pages/waste.js', BASE + 'pages/parts.js', BASE + 'pages/kits.js', BASE + 'pages/restock.js',
  BASE + 'pages/customers.js', BASE + 'pages/suppliers.js', BASE + 'pages/expenses.js', BASE + 'pages/stocktake.js', BASE + 'pages/ai.js',
  BASE + 'pages/product.js',
  BASE + 'lib/photo.js', BASE + 'lib/zxing.min.js',
]
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())) })
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))).then(() => self.clients.claim()))) })
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  // 只接管本站静态资源；跨源（中心库 API）一律放行走网络
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith(BASE)) return
  if (url.pathname.startsWith('/api/')) return
  // 网络优先（防旧缓存），断网回退缓存；导航请求兜底到首页，避免断网白屏
  e.respondWith(
    fetch(e.request)
      .then(res => { if (res && res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)) }; return res })
      .catch(() => caches.match(e.request).then(hit => hit || (e.request.mode === 'navigate' ? caches.match(BASE + 'index.html') : undefined)))
  )
})