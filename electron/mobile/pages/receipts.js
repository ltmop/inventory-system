// receipts.js: 收款登记明细 —— 从「更多 → ' + FiIcon('receipt', 18) + ' 收款登记」进来
//
// 为什么要这一页：原来的「收款对账」是个一次性的全屏面板 —— 填完保存就关掉，
// 只显示「今天各方式实收多少钱」，**看不到这笔登记是谁在什么时候填的**（receipt:list 里
// 有 operator 和 created_at，但从来没人显示过）。老板月底想知道"这 3000 是谁登的"，
// 在手机上原来查不到。这一页就是把登记流水摊开来。
page('receipts', function (app) {
  const METHODS = ['现金', '微信', '支付宝', '其他']
  const MI = { 现金: 'wallet', 微信: 'phone', 支付宝: 'bolt', 其他: 'receipt' }
  let date = today()
  let recon = null
  let list = null

  function today() {
    const d = new Date()
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }

  async function load() {
    recon = null
    list = null
    try { recon = await api('receipt:reconcile', { date: date }) } catch (e) { /* 保持空态 */ }
    try { list = await api('receipt:list', { date: date }) } catch (e) { /* 保持空态 */ }
    render()
  }

  function render() {
    app.innerHTML = ''

    const bar = document.createElement('div')
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 16px'
    bar.innerHTML =
      '<button id="rc-back" style="width:42px;height:42px;border-radius:10px;border:2px solid var(--ink);background:var(--card);font-size:18px;flex:none">←</button>' +
      '<div><div class="font-bold" style="font-size:17px">收款登记明细</div>' +
      '<div class="text-sm text-muted">每天实收登记 + 和营业额对账</div></div>'
    app.appendChild(bar)
    document.getElementById('rc-back').onclick = function () { navigate('more') }

    const wrap = document.createElement('div')
    wrap.style.cssText = 'padding:0 16px 24px'
    wrap.innerHTML =
      '<div class="fld"><label>看哪一天</label><input id="rc-date" type="date" value="' + date + '"></div>' +
      (recon ? summaryBlock(recon) : '<div class="card text-sm text-muted">对账数据没取到 —— 下拉刷新或检查网络。</div>') +
      listBlock() +
      '<button id="rc-open" style="width:100%;height:56px;margin-top:12px;border:none;border-radius:12px;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:17px;font-weight:900">' + FiIcon('edit', 15) + ' 登记 / 修改这一天的实收</button>' +
      '<div class="card text-sm text-muted" style="margin-top:12px">' +
        '<b>差异怎么读</b><br>' +
        '· 差异 ≈ 0 → 账平：收到的钱和开单的营业额对得上<br>' +
        '· 差异为负 → 实收 < 应收：有漏登，或有人赊账没点「赊账」<br>' +
        '· 差异为正 → 实收 > 应收：可能重复登记，或收了往期欠款（正常，但要心里有数）<br>' +
        '· 「赊账未收」是当天挂账没付的部分，不算差异' +
      '</div>'
    app.appendChild(wrap)

    const dateEl = document.getElementById('rc-date')
    if (dateEl) dateEl.onchange = function () { date = this.value; load() }
    document.getElementById('rc-open').onclick = function () { openReceiptPanel() }
  }

  function summaryBlock(r) {
    const diff = Math.abs(r.difference) < 0.5
    const cell = (label, val, color, bg) =>
      '<div style="background:' + (bg || 'rgba(255,255,255,.06)') + ';border-radius:10px;padding:10px 12px">' +
        '<div class="text-sm text-muted">' + label + '</div>' +
        '<div style="font-size:20px;font-weight:800;' + (color ? 'color:' + color : '') + '">' + val + '</div></div>'
    return '<div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      cell('应收（营业额）', fmt(r.revenue)) +
      cell('实收登记', fmt(r.totalReceived), 'var(--green)') +
      cell('赊账未收', fmt(r.credit), '#f59e0b') +
      cell('差异', diff ? '账平 ✓' : fmt(r.difference), diff ? 'var(--green)' : 'var(--red)') +
      '</div>'
  }

  // 登记流水：谁、什么时候、登了多少 —— 这一页的重点
  function listBlock() {
    const rows = (list && list.rows) || []
    if (!rows.length) {
      return '<div class="card"><div class="font-bold" style="margin-bottom:4px">登记流水</div>' +
        '<div class="text-sm text-muted">这一天还没有登记过。点下面那个按钮，把微信/支付宝/现金的实收金额填进去。</div></div>'
    }
    const body = METHODS.filter((m) => rows.some((r) => r.method === m)).map((m) => {
      const r = rows.find((x) => x.method === m)
      return '<div class="split" style="padding:9px 0;border-bottom:1px dashed var(--line)">' +
        '<div><div class="font-bold">' + (MI[m] ? FiIcon(MI[m], 15) : '') + ' ' + escHtml(m) + '</div>' +
          '<div class="text-sm text-muted">' + escHtml(r.operator || '没记是谁登的') + ' · ' + String(r.created_at || '').slice(5, 16).replace('T', ' ') + '</div></div>' +
        '<div style="font-weight:800;font-size:18px">' + fmt(r.amount) + '</div>' +
      '</div>'
    }).join('')
    return '<div class="card"><div class="font-bold" style="margin-bottom:4px">登记流水（' + rows.length + ' 条）</div>' + body + '</div>'
  }

  load()
})
