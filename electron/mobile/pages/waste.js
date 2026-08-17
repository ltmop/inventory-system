// waste.js: 报损登记 —— 活饵死亡/饵料报废/破损，手机记一笔，不占桌面
// 数据：waste:list（最近报损）+ waste:create（登记，与桌面同一套校验：米商品可报小数）
page('waste', function (app) {
  let list = []
  let loaded = false
  let busy = false

  async function load() {
    try { list = await api('waste:list', { limit: 50 }) } catch { list = [] }
    loaded = true
    render()
  }

  function render() {
    app.innerHTML = ''
    if (!loaded) { app.innerHTML = '<div class="text-center text-muted" style="padding:40px">加载中...</div>'; return }

    // 登记入口
    const row = document.createElement('div'); row.className = 'bigrow'
    const btn = document.createElement('button'); btn.className = 'big photo'
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="28" height="28"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>报损登记'
    btn.onclick = startWaste
    row.appendChild(btn)
    app.appendChild(row)

    if (list.length === 0) {
      const empty = document.createElement('div'); empty.className = 'card'
      empty.innerHTML = '<div class="text-center text-sm text-muted" style="padding:8px">还没有报损记录，点上面登记一笔</div>'
      app.appendChild(empty)
      return
    }

    const title = document.createElement('div'); title.className = 'sectitle'
    title.innerHTML = '<span class="tag" style="background:var(--ink)">最近报损</span><span>按批次成本记账</span>'
    app.appendChild(title)
    list.forEach(w => {
      const name = (w.brand || '') + ' ' + (w.model || '') || w.sku_code || '-'
      const card = document.createElement('div'); card.className = 'card'
      card.innerHTML =
        '<div class="split">' +
          '<div><div class="font-bold">' + name + '</div>' +
            '<div class="text-xs text-muted mt-sm">' + (w.reason || '未填原因') + '</div>' +
            '<div class="text-xs text-muted mt-sm">' + (w.created_at || '').slice(0, 16).replace('T', ' ') + '</div></div>' +
          '<div class="text-right">' +
            '<div class="text-lg font-bolder" style="color:var(--red)">-' + w.quantity + '</div>' +
            (w.cost_price ? '<div class="text-xs text-muted mt-sm">成本 ' + fmt(w.cost_price * w.quantity) + '</div>' : '') +
          '</div>' +
        '</div>'
      app.appendChild(card)
    })
  }

  async function startWaste() {
    if (busy) return
    busy = true
    try {
      // 找商品：打字输条码或品名（复用 product:search，免相机也不怕扫码卡死）
      const keyword = prompt('输条码或商品名，找要报损的货')
      if (!keyword) { busy = false; return }
      const rows = await api('product:search', { keyword })
      if (!rows || rows.length === 0) { toast('没找到这个商品'); busy = false; return }
      const p = rows.length === 1 ? rows[0] : await pickOne(rows)
      if (!p) { busy = false; return }
      const isMeter = p.unit === '米'
      const qtyStr = prompt('「' + prodName(p) + '」报损多少' + (isMeter ? '米' : '个/包') + '？', '1')
      const qty = parseFloat(qtyStr)
      const rounded = Math.round(qty * 10) / 10
      if (!(qty > 0) || (isMeter && Math.abs(rounded - qty) > 1e-9)) { toast(isMeter ? '米数要大于 0，最多 1 位小数' : '数量要是 ≥1 的数'); busy = false; return }
      const reason = prompt('什么原因？（活饵死亡/临期报废/破损...）', '临期报废') || '临期报废'
      await api('waste:create', { productId: p.id, quantity: isMeter ? rounded : qty, reason, operator: '手机' })
      toast('已登记报损')
      await load()
    } catch (e) { toast('报损失败: ' + e.message) } finally { busy = false }
  }

  // 搜到多个候选时点选一个
  function pickOne(rows) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.95);z-index:300;display:flex;flex-direction:column;padding:20px;color:#e6edf5'
      overlay.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<div style="font-size:20px;font-weight:700">选要报损的货</div>' +
          '<button id="waste-pick-close" style="width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:20px">✕</button>' +
        '</div>' +
        '<div id="waste-pick-list" style="flex:1;overflow:auto"></div>'
      document.body.appendChild(overlay)
      document.getElementById('waste-pick-close').onclick = () => { overlay.remove(); resolve(null) }
      const box = document.getElementById('waste-pick-list')
      box.innerHTML = rows.map(r =>
        '<div data-waste-pick="' + r.id + '" style="padding:14px 16px;border-radius:10px;background:rgba(255,255,255,.08);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">' +
          '<div style="font-size:18px;font-weight:700">' + prodName(r) + '</div>' +
          '<div style="color:#8fa3c0;font-size:13px">库存 ' + (r.total_stock ?? '?') + '</div>' +
        '</div>'
      ).join('')
      box.querySelectorAll('[data-waste-pick]').forEach(el => {
        el.onclick = () => {
          const hit = rows.find(x => x.id === Number(el.getAttribute('data-waste-pick')))
          overlay.remove()
          resolve(hit || null)
        }
      })
    })
  }

  load()
})
