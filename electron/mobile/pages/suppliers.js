// suppliers.js: 供应商
page('suppliers', function (app) {
  let list = []
  let loaded = false
  async function load() { try { list = await api('supplier:list') } catch { list = [] }; loaded = true; render() }
  function render() {
    app.innerHTML = '<div class="sectitle"><span class="tag">🏭 供应商</span></div>'
    // 空列表是正常情况（还没录供应商），不重刷
    if (!loaded) return
    if (!list.length) { const e = document.createElement('div'); e.className = 'text-center text-muted'; e.style.padding = '30px'; e.textContent = '暂无供应商'; app.appendChild(e); return }
    list.forEach(s => {
      const card = document.createElement('div'); card.className = 'card'
      card.innerHTML =
        '<div class="split">' +
          '<div><div class="font-bold">' + s.name + '</div>' + (s.phone ? '<div class="text-xs text-muted mt-sm">' + s.phone + '</div>' : '') + '</div>' +
          '<div class="text-right text-sm text-muted">货款 ' + fmt(s.total_cost) + '</div>' +
        '</div>'
      app.appendChild(card)
    })
    app.appendChild(Object.assign(document.createElement('div'), { className: 'text-center text-xs text-muted', style: 'padding:12px', textContent: '详细对账请在电脑上操作' }))
  }
  load()
})
