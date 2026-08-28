// today.js: 今日经营小结 + AI打烊日报
page('today', function (app) {
  let data = null
  let aiConfigured = false
  let aiText = null
  let aiLoading = false

  let loaded = false
  async function load() {
    try { data = await api('report:today') } catch { data = null }
    // AI 是否配置（配置了才显示日报卡片，否则隐藏 AI 成分）
    try { const s = await api('ai:status'); aiConfigured = !!s?.configured } catch { aiConfigured = false }
    loaded = true
    render()
    // 有成交且 AI 可用 → 后台生成日报
    if (aiConfigured && data && (data.revenue > 0 || (data.recent || []).length > 0)) {
      await genAiSummary()
    }
  }

  // 生成 AI 打烊日报（失败静默隐藏，不干扰数字报表）
  async function genAiSummary() {
    if (aiLoading) return
    aiLoading = true
    try {
      // 卖得最好的前3（今日 out 流水聚合）
      const byName = {}
      ;(data.recent || []).forEach(t => {
        if (t.type === 'out') {
          const n = (t.brand || '') + ' ' + (t.model || '') || t.sku_code || ''
          byName[n] = (byName[n] || 0) + t.quantity
        }
      })
      const topItems = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, quantity]) => ({ name, quantity }))
      // 低库存前3
      let lowStock = []
      try { lowStock = (await api('report:lowStock')).slice(0, 3).map(r => ({ name: (r.brand || '') + ' ' + (r.model || '') || r.sku_code, total: r.stock })) } catch {}
      const stats = {
        date: new Date().toISOString().slice(0, 10),
        qty: topItems.reduce((s, i) => s + i.quantity, 0),
        revenue: data.revenue || 0, profit: data.profit || 0,
        topItems, lowStock,
      }
      const r = await api('ai:dailySummary', { stats })
      if (r?.ok && r.content) { aiText = r.content; render() }
    } catch { /* 失败静默 */ } finally { aiLoading = false }
  }

  function render() {
    app.innerHTML = ''
    // 只在首次加载前显示加载中；加载失败显示错误且不重刷（防止空数据把服务器刷瘫）
    if (!loaded) { app.innerHTML = '<div class="text-center text-muted" style="padding:40px">加载中...</div>'; return }
    if (!data || data.revenue === undefined) {
      app.innerHTML = '<div class="text-center" style="padding:40px"><div class="text-sm" style="color:var(--red)">今日数据加载失败，稍后重试</div></div>'
      return
    }

    // AI 打烊日报卡片（顶部，一眼看到的 AI 成分）
    if (aiText) {
      const aiCard = document.createElement('div'); aiCard.className = 'card'
      aiCard.style.border = '2px solid var(--gold)'; aiCard.style.background = 'linear-gradient(135deg,#fffdf7,#faf3e3)'
      aiCard.innerHTML =
        '<div class="flex" style="align-items:center;gap:6px;margin-bottom:8px">' +
          '<span class="tag" style="background:var(--gold);color:#fff;border-color:var(--gold)">AI 日报</span>' +
          '<span class="text-xs" style="color:var(--sub)">打烊小结</span>' +
        '</div>' +
        '<div class="text-sm" style="line-height:1.7">' + aiText + '</div>'
      app.appendChild(aiCard)
    } else if (aiConfigured && aiLoading) {
      const aiCard = document.createElement('div'); aiCard.className = 'card'
      aiCard.style.border = '2px dashed var(--gold)'
      aiCard.innerHTML = '<div class="text-sm" style="color:var(--sub)">AI 正在写今日小结...</div>'
      app.appendChild(aiCard)
    }

    const rev = data.revenue || 0, prof = data.profit || 0
    const expense = data.expense || 0
    const net = data.netProfit !== undefined ? data.netProfit : prof - expense
    const margin = rev > 0 ? (prof / rev * 100).toFixed(1) : '-'
    const split = data.paySplit || {}, recv = data.receivable || 0
    const methods = Object.entries(split.byMethod || {}).filter(([, v]) => v > 0)

    // 三件套卡片：营业额 / 毛利 / 净利(盈利)
    const c1 = document.createElement('div'); c1.className = 'card'
    c1.innerHTML =
      '<div class="split">' +
        '<div><div class="text-sm" style="color:var(--sub)">营业额</div><div class="text-2xl font-bolder" style="color:var(--blue)">' + fmt(rev) + '</div></div>' +
        '<div class="text-right"><div class="text-sm" style="color:var(--sub)">毛利</div><div class="text-2xl font-bolder" style="color:var(--green)">' + fmt(prof) + '</div></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)">' +
        '<div><div class="text-sm" style="color:var(--sub)">今日支出</div><div class="text-lg font-bolder" style="color:var(--sand-500,var(--gold))">' + fmt(expense) + '</div></div>' +
        '<div class="text-right"><div class="text-sm" style="color:var(--sub)">盈利(净利)</div><div class="text-2xl font-bolder" style="color:' + (net >= 0 ? 'var(--green)' : 'var(--red)') + '">' + fmt(net) + '</div></div>' +
      '</div>' +
      '<div class="text-xs text-muted mt-sm">毛利率 ' + margin + '% · 应收 ' + fmt(recv) + '</div>'
    app.appendChild(c1)

    // 收款方式对账（现金/微信/支付宝各收了多少、几笔，微信/支付宝列出明细方便核对钱包）
    if (methods.length > 0) {
      const c2 = document.createElement('div'); c2.className = 'card'
      const tags = document.createElement('div'); tags.className = 'gap wrap'
      tags.style.marginTop = '6px'
      methods.forEach(([k, v]) => {
        const cnt = (data.recent || []).filter(t => t.type === 'out' && t.pay_method === k).length
        const t = document.createElement('span'); t.className = 'tag'; t.textContent = k + ' ' + fmt(v) + (cnt > 0 ? ' (' + cnt + '笔)' : '')
        tags.appendChild(t)
      })
      c2.innerHTML = '<div class="font-bold mb-sm">今日收款（对账用）</div><div class="text-xs text-muted mb-sm">微信/支付宝的钱在你自己钱包里，和下面明细核对</div>'
      c2.appendChild(tags)

      // 微信/支付宝收款明细（老板对账：系统记的 vs 钱包实际收的）
      const qrSales = (data.recent || []).filter(t => t.type === 'out' && (t.pay_method === '微信' || t.pay_method === '支付宝'))
      if (qrSales.length > 0) {
        const subTitle = document.createElement('div'); subTitle.className = 'font-bold'; subTitle.style.cssText = 'font-size:13px;margin-top:10px;margin-bottom:4px'
        subTitle.textContent = '扫码收款明细'
        c2.appendChild(subTitle)
        qrSales.forEach(t => {
          const name = (t.brand || '') + ' ' + (t.model || '') || t.sku_code || '-'
          const time = (t.timestamp || '').slice(11, 16)
          const line = document.createElement('div'); line.style.cssText = 'display:flex;justify-content:space-between;padding:3px 0;font-size:12px;border-bottom:1px solid var(--line)'
          line.innerHTML = '<span style="color:var(--sub);width:42px">' + time + '</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</span><span style="color:var(--gold);font-weight:700">' + (t.pay_method === '微信' ? '微' : '支') + ' ' + fmt(t.selling_price * t.quantity) + '</span>'
          c2.appendChild(line)
        })
      }
      app.appendChild(c2)
    }

    // 最近流水
    const recent = data.recent || []
    if (recent.length > 0) {
      const c3 = document.createElement('div'); c3.className = 'card'
      c3.innerHTML = '<div class="font-bold mb-sm">今日流水</div>'
      recent.slice(0, 20).forEach(t => {
        const name = (t.brand || '') + ' ' + (t.model || '') || t.sku_code || '-'
        const time = (t.timestamp || '').slice(11, 16)
        const amt = t.type === 'out' ? fmt(t.selling_price * t.quantity) : (t.type === 'return' ? '退货' : '入库')
        const line = document.createElement('div'); line.style.cssText = 'display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid var(--line)'
        line.innerHTML = '<span style="color:var(--sub);width:42px">' + time + '</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</span><span class="' + (t.type === 'out' ? 'text-blue' : 'text-red') + '">' + amt + '</span>'
        c3.appendChild(line)
      })
      app.appendChild(c3)
    }
  }

  load()
})
