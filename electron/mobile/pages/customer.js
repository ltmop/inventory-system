// customer.js: 客户详情 / 编辑 —— 从客户欠款列表点「详情」进来；也担当「新建客户」
//
// 为什么要这一页：原来的客户欠款页只有一个「还欠多少」的大字，点一下直接弹收款面板。
// 老板打电话催账时最想问的是「他到底欠的是哪几单」—— 那笔账在 customer:statement 里有，
// 但手机上从来没显示过。这一页就是把它显示出来，顺带把改资料/拨号/删除补齐。
//
// 数据来源：列表页把 {id,name,outstanding} 塞进 localStorage('fi-customer-detail') 带过来；
// 明细一律现取（customer:statement），不缓存金额 —— 钱的事不吃缓存。
page('customer', function (app) {
  let seed = null
  try { seed = JSON.parse(localStorage.getItem('fi-customer-detail') || 'null') } catch (e) { seed = null }
  const isNew = !seed || !seed.id
  let c = isNew ? { name: '', phone: '', notes: '' } : Object.assign({}, seed)
  let detail = null   // customer:statement 的返回
  let editing = isNew // 新建时直接进编辑态
  let busy = false

  async function load() {
    if (isNew) { render(); return }
    try {
      detail = await api('customer:statement', { customerId: c.id })
      if (detail && detail.customer) c = Object.assign({}, c, detail.customer)
    } catch (e) { toast('读明细失败：' + (e.message || '')) }
    render()
  }

  const day = (ts) => String(ts || '').slice(5, 16).replace('T', ' ')

  function render() {
    app.innerHTML = ''

    // ---- 顶部 ----
    const bar = document.createElement('div')
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 16px'
    bar.innerHTML =
      '<button id="cd-back" style="width:42px;height:42px;border-radius:10px;border:2px solid var(--ink);background:var(--card);font-size:18px;flex:none">←</button>' +
      '<div style="min-width:0"><div class="font-bold" style="font-size:17px">' + (isNew ? '新建客户' : '客户详情') + '</div>' +
      '<div class="text-sm text-muted">' + escHtml(c.name || '（还没填名字）') + '</div></div>'
    app.appendChild(bar)
    document.getElementById('cd-back').onclick = function () { navigate('customers') }

    const wrap = document.createElement('div')
    wrap.style.cssText = 'padding:0 16px 20px'

    if (editing) {
      // ---- 编辑/新建表单 ----
      wrap.innerHTML =
        '<div class="card">' +
          '<div class="fld"><label>客户姓名（必填）</label><input id="cd-name" value="' + escHtml(c.name || '') + '" placeholder="例：老周"></div>' +
          '<div class="fld"><label>电话</label><input id="cd-phone" type="tel" inputmode="tel" value="' + escHtml(c.phone || '') + '" placeholder="例：13800138000"></div>' +
          '<div class="fld"><label>备注</label><input id="cd-notes" value="' + escHtml(c.notes || '') + '" placeholder="例：常拿饵料，月底结"></div>' +
          '<button id="cd-save" class="okbtn" style="margin-top:8px">' + (isNew ? '建客户' : '保存修改') + '</button>' +
        '</div>' +
        '<div class="card text-sm text-muted">同名客户会被拒（系统靠名字认人）。已有同名提示时，去列表里找到他直接改，别建第二个。</div>'
      wrap.querySelector('#cd-save').onclick = save
    } else {
      // ---- 概览 + 动作 ----
      const owing = (detail && detail.outstanding != null) ? detail.outstanding : (c.outstanding || 0)
      const totalCredit = detail ? detail.total_credit : null
      const paidBack = detail ? detail.total_paid_back : null
      wrap.innerHTML =
        '<div class="card">' +
          '<div class="font-bold" style="font-size:18px">' + escHtml(c.name || '未命名') + '</div>' +
          (c.phone ? '<div class="text-sm text-muted" style="margin-top:2px">' + escHtml(c.phone) + '</div>' : '') +
          (c.notes ? '<div class="text-sm text-muted" style="margin-top:2px">' + escHtml(c.notes) + '</div>' : '') +
          '<div style="margin-top:10px"><div class="text-sm text-muted">还欠</div>' +
            '<div style="font-size:34px;font-weight:900;' + (owing > 0 ? 'color:var(--red)' : 'color:var(--green)') + '">' + fmt(owing) + '</div></div>' +
          (totalCredit != null ? '<div class="text-sm text-muted" style="margin-top:6px">累计赊账 ' + fmt(totalCredit) + ' · 已还 ' + fmt(paidBack) + '</div>' : '') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">' +
          '<button id="cd-pay" style="height:56px;border-radius:12px;border:none;background:var(--green);color:#fff;font-size:17px;font-weight:900">' + FiIcon('wallet', 15) + ' 收款</button>' +
          (c.phone
            ? '<a href="tel:' + escHtml(c.phone) + '" style="height:56px;border-radius:12px;border:2px solid var(--ink);background:var(--card);color:var(--ink);font-size:17px;font-weight:800;display:flex;align-items:center;justify-content:center;text-decoration:none">' + FiIcon('phone', 15) + ' 打电话</a>'
            : '<button id="cd-nophone" style="height:56px;border-radius:12px;border:2px dashed var(--line);background:var(--card);color:var(--sub);font-size:15px;font-weight:700">' + FiIcon('phone', 15) + ' 没填电话</button>') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">' +
          '<button id="cd-edit" style="height:44px;border-radius:10px;border:2px solid var(--ink);background:var(--card);font-size:15px;font-weight:800">' + FiIcon('edit', 15) + ' 改资料</button>' +
          '<button id="cd-del" style="height:44px;border-radius:10px;border:2px solid var(--red);background:#fff;color:var(--red);font-size:15px;font-weight:800">' + FiIcon('trash', 15) + ' 删除客户</button>' +
        '</div>' +
        salesBlock() +
        paymentsBlock()
      wrap.querySelector('#cd-pay').onclick = () => FiCustomer.openPayPanel({ id: c.id, name: c.name, outstanding: owing }, load)
      wrap.querySelector('#cd-edit').onclick = () => { editing = true; render() }
      wrap.querySelector('#cd-del').onclick = removeCustomer
      const nophone = wrap.querySelector('#cd-nophone')
      if (nophone) nophone.onclick = () => { editing = true; render() }
    }

    app.appendChild(wrap)
    if (editing) {
      const el = document.getElementById('cd-name')
      if (el && !el.value) el.focus()
    }
  }

  // 欠款明细：卖出记正、退货记负（与命令层的 owed 口径一致，直接用它算好的数）
  function salesBlock() {
    const sales = (detail && detail.sales) || []
    if (!sales.length) return '<div class="card text-sm text-muted">还没有买过东西 —— 明细是空的。</div>'
    const rows = sales.map((s) => {
      const back = s.type === 'return'
      return '<div class="split" style="padding:8px 0;border-bottom:1px dashed var(--line)">' +
        '<div style="min-width:0;flex:1">' +
          '<div class="font-bold" style="font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (back ? '↩️ ' : '') + escHtml(s.product_name || '-') + '</div>' +
          '<div class="text-sm text-muted">' + day(s.timestamp) + ' · ' + s.quantity + ' 件 · ' + fmt(s.due) + (s.paid && s.paid < s.due ? ' · 已付 ' + fmt(s.paid) : '') + '</div>' +
        '</div>' +
        '<div class="text-right" style="flex:none;font-weight:800;' + (s.owed > 0 ? 'color:var(--red)' : 'color:var(--green)') + '">' + (s.owed > 0 ? '欠 ' + fmt(s.owed) : back ? '-' + fmt(-s.owed) : '已结清') + '</div>' +
      '</div>'
    }).join('')
    return '<div class="card"><div class="font-bold" style="margin-bottom:4px">欠款明细（' + sales.length + ' 单）</div>' + rows + '</div>'
  }

  function paymentsBlock() {
    const pays = (detail && detail.payments) || []
    if (!pays.length) return ''
    const rows = pays.map((p) =>
      '<div class="split" style="padding:8px 0;border-bottom:1px dashed var(--line)">' +
        '<div class="text-sm"><b>' + day(p.created_at) + '</b> ' + escHtml(p.method || '') + '</div>' +
        '<div style="font-weight:800;color:var(--green)">已还 ' + fmt(p.amount) + '</div>' +
      '</div>').join('')
    return '<div class="card"><div class="font-bold" style="margin-bottom:4px">还款记录（' + pays.length + ' 笔）</div>' + rows + '</div>'
  }

  async function save() {
    if (busy) return
    const name = document.getElementById('cd-name').value.trim()
    if (!name) { toast('客户姓名不能空'); return }
    const payload = {
      name: name,
      phone: document.getElementById('cd-phone').value.trim(),
      notes: document.getElementById('cd-notes').value.trim(),
    }
    busy = true
    const btn = document.getElementById('cd-save')
    if (btn) { btn.disabled = true; btn.textContent = '保存中…' }
    try {
      if (isNew) {
        const r = await api('customer:create', payload)
        c = Object.assign({}, c, r && r.id ? r : payload)
        toast('已建客户「' + name + '」')
      } else {
        const r = await api('customer:update', Object.assign({ id: c.id }, payload))
        c = Object.assign({}, c, r && r.id ? r : payload)
        toast('已保存')
      }
      editing = false
      await load()
    } catch (e) {
      toast((isNew ? '建客户失败：' : '保存失败：') + (e.message || ''))
      if (btn) { btn.disabled = false; btn.textContent = isNew ? '建客户' : '保存修改' }
      busy = false
    }
  }

  // 删除：命令层要老板权限，且**有流水或还款记录的一律拒绝**（删了会弄丢赊账历史）
  async function removeCustomer() {
    if (!confirm('删除客户「' + (c.name || '') + '」？\n\n只有从没买过东西、也没还过款的客户能删；有历史的会被拦下。')) return
    try {
      const r = await api('customer:delete', { id: c.id })
      if (r && r.ok === false) { toast(r.reason || '这个客户不能删'); return }
      toast('已删除')
      navigate('customers')
    } catch (e) { toast('删除失败：' + (e.message || '')) }
  }

  load()
})
