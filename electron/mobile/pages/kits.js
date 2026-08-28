// kits.js: 套装 —— 新手套装/绑钩套装，点开看明细（在电脑上建，手机上看）
// 数据：kit:list + kit:get（明细带商品名/数量）
page('kits', function (app) {
  let kits = []
  let loaded = false

  async function load() {
    try { kits = await api('kit:list') } catch { kits = [] }
    loaded = true
    render()
  }

  function render() {
    app.innerHTML = ''
    if (!loaded) { app.innerHTML = '<div class="text-center text-muted" style="padding:40px">加载中...</div>'; return }
    if (!kits || kits.length === 0) {
      app.innerHTML =
        '<div class="text-center" style="padding:40px"><div style="font-size:44px">🧰</div>' +
        '<div class="font-bold mt">还没有套装</div>' +
        '<div class="text-sm text-muted mt-sm">在电脑上建新手套装/绑钩套装，手机上点开看明细</div></div>'
      return
    }

    const title = document.createElement('div'); title.className = 'sectitle'
    title.innerHTML = '<span class="tag" style="background:var(--ink)">套装</span><span>点开看明细</span>'
    app.appendChild(title)

    kits.forEach(k => {
      const card = document.createElement('div'); card.className = 'card'; card.style.cursor = 'pointer'
      card.innerHTML =
        '<div class="split">' +
          '<div><div class="font-bold">' + k.name + '</div>' +
            '<div class="text-xs text-muted mt-sm">' + k.item_count + ' 种商品</div></div>' +
          '<div style="color:var(--sub);font-size:20px">›</div>' +
        '</div>'
      card.onclick = () => openKit(k.id)
      app.appendChild(card)
    })
  }

  async function openKit(id) {
    try {
      const detail = await api('kit:get', { id })
      if (!detail || !detail.items) throw new Error('返回异常')
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.95);z-index:300;display:flex;flex-direction:column;padding:20px;color:#e6edf5'
      overlay.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<div style="font-size:20px;font-weight:700">' + (detail.kit ? detail.kit.name : '套装明细') + '</div>' +
          '<button id="kit-close" style="width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:20px">✕</button>' +
        '</div>' +
        '<div id="kit-items" style="flex:1;overflow:auto"></div>'
      document.body.appendChild(overlay)
      document.getElementById('kit-close').onclick = () => overlay.remove()
      const box = document.getElementById('kit-items')
      box.innerHTML = detail.items.map(it =>
        '<div style="padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.08);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">' +
          '<div><div style="font-size:16px;font-weight:700">' + (it.product_name || '') + '</div>' +
          '<div style="color:#8fa3c0;font-size:12px;margin-top:2px">' + (it.sku_code || '') + (it.suggest_price ? ' · ' + fmt(it.suggest_price) : '') + '</div></div>' +
          '<div style="font-size:18px;font-weight:800;color:var(--gold)">×' + it.quantity + '</div>' +
        '</div>'
      ).join('')
    } catch (e) { toast('加载失败: ' + e.message) }
  }

  load()
})
