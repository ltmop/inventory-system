// customers.js: 客户欠款 —— 大字一眼看明白，点客户直接收款，点「详情」看欠的是哪几单
//
// 2026-09-21 改：① 收款面板抽到 lib/customer.js（详情页与这里共用一份，不再复制粘贴）
//               ② 卡片加「详情」入口（催账时最想问"他欠的是哪几单"，那笔账在 customer:statement 里）
//               ③ 加「＋ 新增客户」（原来手机上只能在开单页顺带建客户）
page('customers', function (app) {
  let list = []

  async function load() {
    try { list = await api('customer:list') } catch { list = [] }
    render()
  }

  // 收款走共享面板（lib/customer.js）；收完刷新本页
  function openPayPanel(c) { FiCustomer.openPayPanel(c, load) }

  // 进客户详情：把这一行带过去，明细由详情页现取（钱的事不吃缓存）
  function openDetail(c) {
    try { localStorage.setItem('fi-customer-detail', JSON.stringify({ id: c.id, name: c.name, outstanding: c.outstanding })) } catch (e) { /* 存不下时详情页会兜底 */ }
    navigate('customer')
  }

  function addCustomer() {
    try { localStorage.removeItem('fi-customer-detail') } catch (e) { /* 忽略 */ }
    navigate('customer')
  }

  function render() {
    app.innerHTML = '<div class="sectitle"><span class="tag" style="background:var(--red)">欠款客户</span><span>点人收款 · 点「详情」看欠的是哪几单</span></div>'

    // 「＋ 新增客户」放最上面（不管有没有欠款都要能建人）
    const addBtn = document.createElement('button')
    addBtn.style.cssText = 'margin:0 16px 10px;width:calc(100% - 32px);height:44px;border-radius:10px;border:2px dashed var(--ink);background:var(--card);font-size:15px;font-weight:800;color:var(--ink)'
    addBtn.innerHTML = FiIcon('plus', 15) + ' 新增客户'
    addBtn.onclick = addCustomer
    app.appendChild(addBtn)

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
          '<div style="flex:1"><div class="font-bold" style="font-size:18px">' + escHtml(c.name || '未命名') + '</div>' +
            (c.phone ? '<div class="text-sm text-muted mt-sm">' + escHtml(c.phone) + '</div>' : '') +
          '</div>' +
          '<div class="text-right"><div style="font-size:24px;font-weight:900;color:var(--red)">' + fmt(c.outstanding) + '</div>' +
            '<div class="text-sm text-muted">点此收款</div></div>' +
        '</div>' +
        '<button data-detail style="width:100%;height:38px;margin-top:8px;border-radius:8px;border:2px solid var(--gold);background:var(--card);color:var(--gold);font-size:14px;font-weight:800">' + FiIcon('clipboard', 15) + ' 详情 / 欠款明细 · 改资料 · 打电话</button>'
      // 点卡片 = 直接收款（催账最快的那条路，不能被打断）；详情走按钮
      card.onclick = () => openPayPanel(c)
      const dbtn = card.querySelector('[data-detail]')
      if (dbtn) dbtn.onclick = (e) => { e.stopPropagation(); openDetail(c) }
      app.appendChild(card)
    })
  }
  // 首帧：上次的客户列表直接上屏（网络结果回来再覆盖）；没有缓存就照旧显示加载中
  const cachedCustomers = apiCached('customer:list')
  if (cachedCustomers && cachedCustomers.length) { list = cachedCustomers; render() }
  load()
})
