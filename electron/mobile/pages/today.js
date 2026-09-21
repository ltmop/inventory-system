// today.js: 今日经营小结 + AI打烊日报
page('today', function (app) {
  let data = null
  let aiConfigured = false
  let lowStockCount = 0     // 库存告急品种数（在 load 里取一次，render 直接用）
  let aiText = null
  let aiLoading = false

  let loaded = false
  async function load() {
    try { data = await api('report:today') } catch { data = null }
    // AI 是否配置（配置了才显示日报卡片，否则隐藏 AI 成分）
    try { const s = await api('ai:status'); aiConfigured = !!s?.configured } catch { aiConfigured = false }
    try { lowStockCount = (((await api('report:lowStock')) || []).length) } catch { lowStockCount = 0 }
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
        date: fiLocalDate(),
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

    // 固定营收条：营业额/毛利/净利 钉在顶部，往下翻流水和对账也一直看得到今天的数
    const d = new Date()
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
    const fixed = document.createElement('div'); fixed.className = 'sticky-bar'
    fixed.innerHTML =
      '<div class="today-fixed">' +
        '<div class="d">' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · ' + wd + ' · 今日经营</div>' +
        '<div class="row3">' +
          '<div class="m"><div class="k">营业额</div><div class="v" id="tv-rev" data-fen="' + rev + '" style="color:var(--blue)">' + fmt(rev) + '</div></div>' +
          '<div class="m"><div class="k">毛利</div><div class="v" id="tv-prof" data-fen="' + prof + '" style="color:var(--ok)">' + fmt(prof) + '</div></div>' +
          '<div class="m"><div class="k">净利</div><div class="v" id="tv-net" data-fen="' + net + '" style="color:' + (net >= 0 ? 'var(--ok)' : 'var(--danger)') + '">' + fmt(net) + '</div></div>' +
        '</div>' +
        '<div class="d" style="margin-top:5px">毛利率 ' + margin + '% · 支出 ' + fmt(expense) + ' · 应收 ' + fmt(recv) + '</div>' +
      '</div>'
    // 营收条必须是这一页最上面的东西（原来排在 AI 日报卡下面，第一眼看到的却是日报）
    app.insertBefore(fixed, app.firstChild || null)

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
          const time = fiHHMM(t.timestamp)
          const line = document.createElement('div'); line.style.cssText = 'display:flex;justify-content:space-between;padding:3px 0;font-size:12px;border-bottom:1px solid var(--line)'
          line.innerHTML = '<span style="color:var(--sub);width:42px">' + time + '</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</span><span style="color:var(--gold);font-weight:700">' + (t.pay_method === '微信' ? '微' : '支') + ' ' + fmt(t.selling_price * t.quantity) + '</span>'
          c2.appendChild(line)
        })
      }
      app.appendChild(c2)
    }

    // ===== 数据分析图：收款方式占比 + 今日时段分布（老板看的就是这个）=====
    const methodsArr = methods.map(function (kv) { return { name: kv[0], val: kv[1] } }).sort(function (a, b) { return b.val - a.val })
    const outTx = (data.recent || []).filter(function (t) { return t.type === 'out' })
    const buckets = []
    for (let h = 0; h < 24; h += 3) buckets.push({ label: h + '点', val: 0 })
    outTx.forEach(function (t) {
      const hh = fiHour(t.timestamp)
      if (!isNaN(hh)) buckets[Math.floor(hh / 3)].val += (t.selling_price || 0) * (t.quantity || 0)
    })
    const maxBucket = Math.max(1, ...buckets.map(function (b) { return b.val }))
    const totalOut = Math.max(1, methodsArr.reduce(function (s, m) { return s + m.val }, 0))

    const cChart = document.createElement('div'); cChart.className = 'card'
    cChart.style.animation = 'cardIn .4s var(--ease) both'
    cChart.innerHTML =
      '<div class="flex" style="align-items:center;gap:7px;margin-bottom:10px">' +
        '<span style="color:var(--blue);display:flex">' + FiIcon('chart', 17) + '</span>' +
        '<div class="font-bold" style="font-size:14.5px">今日数据分析</div>' +
        '<span class="text-xs text-muted" style="margin-left:auto">' + (outTx.length ? (outTx.length + ' 笔成交') : '今天还没卖出') + '</span>' +
      '</div>' +
      (methodsArr.length
        ? '<div class="text-xs text-muted" style="margin-bottom:6px">收款方式</div>' +
          methodsArr.map(function (m, i) {
            const pct = Math.round((m.val / totalOut) * 100)
            return '<div style="margin-bottom:9px">' +
              '<div class="flex" style="justify-content:space-between;font-size:12.5px"><span>' + escHtml(m.name) + '</span>' +
              '<span class="text-muted">' + fmt(m.val) + ' · ' + pct + '%</span></div>' +
              '<div class="bar"><i style="width:' + pct + '%;animation-delay:' + (i * 90) + 'ms"></i></div></div>'
          }).join('')
        : '<div class="empty" style="padding:10px 0">今天还没有收款记录，图表会随着开单自动长出来。</div>') +
      '<div class="text-xs text-muted" style="margin:12px 0 6px">今日各时段营业额</div>' +
      '<div class="barchart">' +
        buckets.map(function (b, i) {
          const h = Math.round((b.val / maxBucket) * 100)
          return '<div class="bc-col"><div class="bc-bar" style="height:' + Math.max(2, h) + '%;animation-delay:' + (i * 45) + 'ms"></div>' +
            '<div class="bc-lab">' + (i % 2 === 0 ? b.label : '') + '</div></div>'
        }).join('') +
      '</div>'
    app.appendChild(cChart)

    // ===== 运营额度：一眼看清"账上还欠多少 / 哪些货告急 / AI 还能不能用" =====
    const lowStockN = lowStockCount
    const ops = document.createElement('div'); ops.className = 'card'
    ops.style.animation = 'cardIn .45s var(--ease) both'
    ops.innerHTML =
      '<div class="flex" style="align-items:center;gap:7px;margin-bottom:10px">' +
        '<span style="color:var(--blue);display:flex">' + FiIcon('pulse', 17) + '</span>' +
        '<div class="font-bold" style="font-size:14.5px">运营额度</div>' +
      '</div>' +
      '<div class="stat-grid">' +
        '<div class="stat"><div class="k">客户欠款（应收）</div><div class="v" style="color:' + (recv > 0 ? 'var(--warn)' : 'var(--ok)') + '">' + fmt(recv) + '</div></div>' +
        '<div class="stat"><div class="k">库存告急</div><div class="v" style="color:' + (lowStockN > 0 ? 'var(--danger)' : 'var(--ok)') + '">' + lowStockN + ' 种</div></div>' +
        '<div class="stat"><div class="k">今日支出</div><div class="v">' + fmt(expense) + '</div></div>' +
        '<div class="stat"><div class="k">AI 助手</div><div class="v" style="font-size:15px;color:' + (aiConfigured ? 'var(--ok)' : 'var(--sub)') + '">' + (aiConfigured ? '已接通' : '未配置') + '</div></div>' +
      '</div>'
    app.appendChild(ops)

    // 数字滚动动画（营收/毛利/净利从 0 长上去）
    try {
      ;['tv-rev', 'tv-prof', 'tv-net'].forEach(function (id) {
        const el = document.getElementById(id)
        if (!el) return
        const target = Number(el.getAttribute('data-fen')) || 0
        const t0 = Date.now()
        const tick = function () {
          const k = Math.min(1, (Date.now() - t0) / 650)
          const ease = 1 - Math.pow(1 - k, 3)
          el.textContent = fmt(Math.round(target * ease))
          if (k < 1) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    } catch (e) { /* 动画失败不影响数字 */ }

    // 最近流水
    const recent = data.recent || []
    if (recent.length > 0) {
      const c3 = document.createElement('div'); c3.className = 'card'
      c3.innerHTML = '<div class="font-bold mb-sm">今日流水</div>'
      recent.slice(0, 20).forEach(t => {
        const name = (t.brand || '') + ' ' + (t.model || '') || t.sku_code || '-'
        const time = fiHHMM(t.timestamp)
        const amt = t.type === 'out' ? fmt(t.selling_price * t.quantity) : (t.type === 'return' ? '退货' : '入库')
        const line = document.createElement('div'); line.style.cssText = 'display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid var(--line)'
        line.innerHTML = '<span style="color:var(--sub);width:42px">' + time + '</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</span><span class="' + (t.type === 'out' ? 'text-blue' : 'text-red') + '">' + amt + '</span>'
        c3.appendChild(line)
      })
      app.appendChild(c3)
    }
  }

  // 首帧：上次的今日数据 + AI 配置直接上屏，网络结果回来再覆盖
  if (!loaded) {
    const c0 = apiCached('report:today')
    const c1 = apiCached('ai:status')
    if (c0) { data = c0; aiConfigured = !!(c1 && c1.configured); loaded = true; render() }
  }
  load()
})