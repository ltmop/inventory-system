// expiring.js: 临期/过期预警 —— 饵料/小药/活饵哪批快到期，躺炕上也能看
// 数据：product:expiring（按批次算，已过期排最前）
page('expiring', function (app) {
  let items = []
  let loaded = false

  async function load() {
    try { items = await api('product:expiring', { days: 30 }) } catch { items = [] }
    loaded = true
    render()
  }

  function render() {
    app.innerHTML = ''
    if (!loaded) { app.innerHTML = '<div class="text-center text-muted" style="padding:40px">加载中...</div>'; return }
    if (!items || items.length === 0) {
      app.innerHTML =
        '<div class="text-center" style="padding:40px"><div style="font-size:44px">🎉</div>' +
        '<div class="font-bold mt">30 天内没有要过期的</div>' +
        '<div class="text-sm text-muted mt-sm">饵料/小药/活饵这些保质期货都新鲜</div></div>'
      return
    }
    const title = document.createElement('div'); title.className = 'sectitle'
    title.innerHTML = '<span class="tag" style="background:var(--red)">临期预警</span><span>30 天内到期 + 已过期</span>'
    app.appendChild(title)

    const expired = items.filter(x => x.expired)
    const soon = items.filter(x => !x.expired && x.daysLeft <= 7)
    const later = items.filter(x => !x.expired && x.daysLeft > 7)
    ;[['已过期', expired, 'var(--red)'], ['7 天内到期', soon, 'var(--gold)'], ['30 天内到期', later, 'var(--blue)']].forEach(([label, list, color]) => {
      if (list.length === 0) return
      const sec = document.createElement('div'); sec.className = 'sectitle'
      sec.innerHTML = '<span class="tag" style="background:' + color + '">' + label + '</span><span>' + list.length + ' 批</span>'
      app.appendChild(sec)
      list.forEach(it => {
        const card = document.createElement('div'); card.className = 'card'
        const badge = it.expired
          ? '<span class="badge badge-red">已过期 ' + Math.abs(it.daysLeft) + ' 天</span>'
          : '<span class="badge" style="background:var(--gold);color:#fff">剩 ' + it.daysLeft + ' 天</span>'
        card.innerHTML =
          '<div class="split">' +
            '<div><div class="font-bold">' + it.name + '</div>' +
              '<div class="text-xs text-muted mt-sm">' + it.sku + (it.batch_no ? ' · ' + it.batch_no : '') + '</div>' +
              '<div class="text-xs text-muted">到期 ' + it.expiry_date + '</div></div>' +
            '<div class="text-right">' + badge + '<div class="text-sm text-muted mt-sm">库存 ' + it.stock + '</div></div>' +
          '</div>'
        app.appendChild(card)
      })
    })
  }

  load()
})
