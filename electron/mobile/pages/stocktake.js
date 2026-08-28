// stocktake.js: 渐进式盘点
page('stocktake', function (app) {
  let locations = [], currentLoc = '', products = [], counts = {}, busy = false
  let loaded = false

  async function load() {
    try {
      const all = await api('product:search', { keyword: ' ' }) || []
      const byLoc = {}
      all.forEach(p => { const loc = p.location || '未设库位'; if (!byLoc[loc]) byLoc[loc] = []; byLoc[loc].push(p) })
      locations = Object.keys(byLoc).sort((a, b) => {
        const aMax = Math.max(...(byLoc[a] || []).map(p => new Date(p.updated_at || 0).getTime()), 0)
        const bMax = Math.max(...(byLoc[b] || []).map(p => new Date(p.updated_at || 0).getTime()), 0)
        return aMax - bMax
      })
    } catch { locations = [] }
    loaded = true
    render()
  }

  function render() {
    app.innerHTML = ''
    app.innerHTML += '<div class="sectitle"><span class="tag">📋 核对货架</span><span>每天核对一小片</span></div>'
    if (currentLoc) { renderStocktake(); return }
    // 没有盘点区域是正常情况（商品没货位），不重刷
    if (!loaded) return
    if (!locations.length) { app.innerHTML += '<div class="text-center text-muted" style="padding:30px">没有可盘点的区域</div>'; return }
    const nextLoc = locations[0]
    const card = document.createElement('div'); card.className = 'card text-center'
    card.innerHTML =
      '<div class="text-sm text-muted">今天建议核对</div>' +
      '<div class="text-xl font-bold text-blue mt-sm">' + (nextLoc || '全部') + '</div>'
    const btn = document.createElement('button'); btn.className = 'okbtn'; btn.style.marginTop = '14px'; btn.textContent = '核对一下这格货架'
    btn.onclick = () => { currentLoc = nextLoc; counts = {}; products = []; renderStocktake() }
    card.appendChild(btn); app.appendChild(card)
  }

  function renderStocktake() {
    app.innerHTML = ''
    app.innerHTML += '<div class="card"><div class="font-bold">核对: ' + currentLoc + '</div></div>'
    products.forEach(p => {
      const name = prodName(p)
      const card = document.createElement('div'); card.className = 'card'
      card.innerHTML =
        '<div class="split">' +
          '<div style="flex:1"><div class="font-bold text-sm">' + name + '</div></div>' +
          '<input type="number" min="0" value="' + (counts[p.product_id] !== undefined ? counts[p.product_id] : '') + '" style="width:70px;padding:8px;border:2px solid var(--ink);border-radius:6px;text-align:center;font-size:14px;background:var(--card)" placeholder="数量">' +
        '</div>'
      card.querySelector('input').oninput = function (e) { counts[p.product_id] = parseInt(e.target.value) || 0 }
      app.appendChild(card)
    })
    if (!busy) {
      const btn = document.createElement('button'); btn.className = 'okbtn'; btn.style.margin = '10px 16px'; btn.style.width = 'calc(100% - 32px)'; btn.textContent = '确认无误，提交核对'
      btn.onclick = submit; app.appendChild(btn)
    }
  }

  async function submit() {
    if (busy) return; busy = true
    try { await api('stocktake:submit', { operator: '手机' }); showStamp('已核对', currentLoc, true); currentLoc = ''; load() }
    catch (e) { toast('提交失败: ' + e.message); busy = false }
  }

  load()
})
