// customers.js: 客户欠款 —— 大字一眼看明白，点客户弹收款面板一键收款
page('customers', function (app) {
  let list = []

  async function load() {
    try { list = await api('customer:list') } catch { list = [] }
    render()
  }

  // 收款面板：全屏，大字，不用浏览器 prompt（手机上 prompt 体验差）
  function openPayPanel(c) {
    const overlay = document.createElement('div')
    overlay.id = 'pay-overlay'
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.92);z-index:300;display:flex;flex-direction:column;padding:24px;color:#e6edf5'
    const owing = c.outstanding || 0
    overlay.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<div class="text-lg font-bold" style="font-size:22px">' + (c.name || '客户') + '</div>' +
        '<button id="pay-close" style="width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:20px">✕</button>' +
      '</div>' +
      '<div class="text-sm" style="color:#8fa3c0">还欠</div>' +
      '<div class="font-bold" style="font-size:40px;color:#ff6b6b;margin:4px 0 20px">' + fmt(owing) + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">' +
        '<button id="pay-full" class="pay-btn" style="grid-column:span 2">收全款 ' + fmt(owing) + '</button>' +
        '<button id="pay-half" class="pay-btn">还一半 ' + fmt(Math.round(owing/2)) + '</button>' +
        '<button id="pay-hundred" class="pay-btn">还 100 元</button>' +
      '</div>' +
      '<div class="text-sm" style="color:#8fa3c0;margin-bottom:6px">或自定义金额（元）</div>' +
      '<input id="pay-custom" type="number" inputmode="decimal" placeholder="填金额" style="height:56px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);border-radius:12px;color:#fff;font-size:20px;padding:0 16px;margin-bottom:14px;width:100%">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:18px">' +
        '<button id="pay-wx" class="pay-btn" style="background:#07c160">微信</button>' +
        '<button id="pay-cash" class="pay-btn" style="background:#f5a623">现金</button>' +
        '<button id="pay-ali" class="pay-btn" style="background:#1677ff">支付宝</button>' +
      '</div>' +
      '<button id="pay-go" style="height:60px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:20px;font-weight:800">确认收款</button>'
    document.body.appendChild(overlay)

    let method = '微信'
    let amount = owing // 默认全款

    const setAmount = (v) => { amount = v; document.getElementById('pay-go').textContent = '确认收款 ' + fmt(amount) }
    document.getElementById('pay-close').onclick = () => overlay.remove()
    document.getElementById('pay-full').onclick = () => setAmount(owing)
    document.getElementById('pay-half').onclick = () => setAmount(Math.round(owing / 2))
    document.getElementById('pay-hundred').onclick = () => setAmount(Math.min(10000, owing))
    document.getElementById('pay-custom').oninput = function () {
      const v = parseFloat(this.value)
      if (Number.isFinite(v) && v > 0) setAmount(Math.round(v * 100))
    }
    document.getElementById('pay-wx').onclick = () => { method = '微信'; highlight('pay-wx') }
    document.getElementById('pay-cash').onclick = () => { method = '现金'; highlight('pay-cash') }
    document.getElementById('pay-ali').onclick = () => { method = '支付宝'; highlight('pay-ali') }
    function highlight(id) {
      ;['pay-wx', 'pay-cash', 'pay-ali'].forEach((x) => {
        document.getElementById(x).style.outline = x === id ? '3px solid #fff' : 'none'
      })
    }
    document.getElementById('pay-go').onclick = async () => {
      if (!amount || amount <= 0) { toast('填个金额'); return }
      overlay.querySelector('#pay-go').disabled = true
      overlay.querySelector('#pay-go').textContent = '收款中...'
      try {
        await api('payment:record', { customerId: c.id, amount, method, notes: null })
        overlay.remove()
        toast('已收 ' + fmt(amount) + '（' + method + '）')
        load()
      } catch (e) { toast('收款失败: ' + e.message); overlay.querySelector('#pay-go').disabled = false; overlay.querySelector('#pay-go').textContent = '确认收款' }
    }
  }

  function render() {
    app.innerHTML = '<div class="sectitle"><span class="tag" style="background:var(--red)">欠款客户</span><span>点人收款</span></div>'
    const debtors = list.filter(c => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding)
    if (!debtors.length) {
      const e = document.createElement('div')
      e.className = 'text-center text-muted'; e.style.padding = '40px'
      e.textContent = '没有欠款，大家都清了'
      app.appendChild(e)
      return
    }
    // 总欠款大字
    const total = debtors.reduce((s, c) => s + c.outstanding, 0)
    const totalCard = document.createElement('div'); totalCard.className = 'card text-center'
    totalCard.innerHTML = '<div class="text-sm text-muted">共 ' + debtors.length + ' 人欠款</div><div style="font-size:36px;font-weight:900;color:var(--red);margin-top:4px">' + fmt(total) + '</div>'
    app.appendChild(totalCard)

    debtors.forEach(c => {
      const card = document.createElement('div'); card.className = 'card'; card.style.cursor = 'pointer'
      card.innerHTML =
        '<div class="split">' +
          '<div style="flex:1"><div class="font-bold" style="font-size:18px">' + (c.name || '未命名') + '</div>' +
            (c.phone ? '<div class="text-sm text-muted mt-sm">' + c.phone + '</div>' : '') +
          '</div>' +
          '<div class="text-right"><div style="font-size:24px;font-weight:900;color:var(--red)">' + fmt(c.outstanding) + '</div>' +
            '<div class="text-sm text-muted">点此收款</div></div>' +
        '</div>'
      card.onclick = () => openPayPanel(c)
      app.appendChild(card)
    })
  }
  load()
})
