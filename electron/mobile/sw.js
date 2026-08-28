// Service Worker: 离线缓存手机页，打开秒出，断网不白屏
const CACHE = 'adu-v3.0'
const ASSETS = [
  '/m/', '/m/index.html', '/m/app.js', '/m/manifest.json',
  '/m/pages/pos.js', '/m/pages/inbound.js', '/m/pages/stock.js', '/m/pages/today.js',
  '/m/pages/expiring.js', '/m/pages/waste.js', '/m/pages/parts.js', '/m/pages/kits.js', '/m/pages/restock.js',
  '/m/pages/customers.js', '/m/pages/suppliers.js', '/m/pages/expenses.js', '/m/pages/stocktake.js',
  '/m/lib/zxing.min.js',
]

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))) })
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))) })
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  if (!url.pathname.startsWith('/m/')) return
  // API 调用不做缓存，走网络
  if (url.pathname.startsWith('/api/')) return
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetched = fetch(e.request).then(res => { if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)) }; return res })
      return cached || fetched
    })
  )
})
