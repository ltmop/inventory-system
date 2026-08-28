// parts.js: 配节库存 —— 各主竿的竿梢/手把节/中节还有多少，缺货一眼看到
// 数据：part:all（所有配节 + 主竿名 + 库存），按主竿分组，低于预警线(默认5)标红
page('parts', function (app) {
  let parts = []
  let loaded = false

  async function load() {
    try { parts = await api('part:all', {}) } catch { parts = [] }
    loaded = true
    render()
  }

  function render() {
    app.innerHTML = ''
    if (!loaded) { app.innerHTML = '<div class="text-center text-muted" style="padding:40px">加载中...</div>'; return }
    if (!parts || parts.length === 0) {
      app.innerHTML =
        '<div class="text-center" style="padding:40px"><div style="font-size:44px">🎣</div>' +
        '<div class="font-bold mt">还没有设配节</div>' +
        '<div class="text-sm text-muted mt-sm">在电脑上把竿梢/手把节绑到主竿，手机上就能查库存</div></div>'
      return
    }

    const title = document.createElement('div'); title.className = 'sectitle'
    title.innerHTML = '<span class="tag" style="background:var(--ink)">配节库存</span><span>低于预警线标红</span>'
    app.appendChild(title)

    // 按主竿分组
    const groups = {}
    parts.forEach(p => {
      const pid = p.parent_id ?? 0
      if (!groups[pid]) groups[pid] = { name: p.parent_name || ('主竿#' + pid), items: [] }
      groups[pid].items.push(p)
    })

    Object.values(groups).forEach(g => {
      const sec = document.createElement('div'); sec.className = 'sectitle'
      sec.innerHTML = '<span class="tag">' + g.name + '</span><span>' + g.items.length + ' 节</span>'
      app.appendChild(sec)
      g.items.forEach(it => {
        const threshold = it.min_stock ?? 5
        const low = it.stock < threshold
        const card = document.createElement('div'); card.className = 'card'
        card.innerHTML =
          '<div class="split">' +
            '<div><div class="font-bold">' + prodName(it) + '</div>' +
              '<div class="text-xs text-muted mt-sm">' + (it.part_type || '配节') + ' · ' + it.sku_code + '</div></div>' +
            '<div class="text-right">' +
              '<div class="text-lg font-bolder" style="color:' + (low ? 'var(--red)' : 'var(--green)') + '">' + it.stock + '</div>' +
              '<div class="text-xs text-muted mt-sm">' + (low ? '缺货！低于 ' + threshold : '库存充足') + '</div>' +
            '</div>' +
          '</div>'
        app.appendChild(card)
      })
    })
  }

  load()
})
