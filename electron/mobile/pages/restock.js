// restock.js: 补货清单
page('restock', function (app) {
  let items = []
  let loaded = false
  async function load() { try { items = await api('report:lowStock') } catch { items = [] }; loaded = true; render() }
  function render() {
    app.innerHTML = '<div class="sectitle"><span class="tag">⚠️ 补货清单</span></div>'
    // AI 补货入口：让 AI 分析该补什么（点开 AI 助手）
    const aiBtn = document.createElement('div'); aiBtn.className = 'card'; aiBtn.style.cssText = 'cursor:pointer;border:2px dashed var(--gold);margin-bottom:10px'
    aiBtn.innerHTML = '<div class="flex" style="align-items:center;gap:8px">' +
      '<span style="font-size:20px">🤖</span>' +
      '<div style="flex:1"><div class="font-bold" style="color:var(--gold)">让 AI 算该补什么</div><div class="text-xs" style="color:var(--sub)">结合销量/库存/滞销，给建议</div></div>' +
      '<span style="color:var(--gold)">→</span></div>'
    aiBtn.onclick = () => navigate('ai')
    app.appendChild(aiBtn)
    // 空数据是正常情况（库存健康），不重刷，防止把服务器刷瘫
    if (!loaded) return
    if (items.length === 0) {
      const e = document.createElement('div'); e.className = 'text-center text-muted'; e.style.padding = '40px'; e.textContent = '库存健康，无需补货'; app.appendChild(e); return
    }
    items.forEach(p => {
      const card = document.createElement('div'); card.className = 'card'
      const name = (p.brand || '') + ' ' + (p.model || '') || p.sku_code || ''
      card.innerHTML =
        '<div class="split">' +
          '<div><div class="font-bold">' + name + '</div><div class="text-xs text-muted mt-sm">近30天卖 ' + (p.sold30 || 0) + ' 件</div></div>' +
          '<div class="text-right"><span class="badge badge-red">剩 ' + (p.stock || 0) + ' 件</span>' + (p.suggested_qty ? '<div class="text-xs text-blue mt-sm">建议补 ' + p.suggested_qty + ' 件</div>' : '') + '</div>' +
        '</div>'
      app.appendChild(card)
    })
  }
  load()
})
