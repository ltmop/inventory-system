// expenses.js: 支出记账 —— 记一笔房租/水电/进货，净利自动扣掉
page('expenses', function (app) {
  const CATS = ['进货付款', '房租', '水电', '运费', '人工', '杂项']

  function render() {
    app.innerHTML = ''
    app.innerHTML += '<div class="sectitle"><span class="tag" style="background:var(--red)">支出记账</span><span>记一笔，净利自动扣</span></div>'
    const form = document.createElement('div'); form.className = 'card'
    form.innerHTML =
      '<div class="text-sm text-muted" style="margin-bottom:12px">花出去的钱记这里，今日盈利才算得准</div>' +
      '<div class="fld"><label>分类</label><select id="exp-cat" style="height:50px;width:100%;border:2px solid var(--ink);border-radius:10px;background:#fff;padding:0 12px;font-size:16px">' + CATS.map((c) => '<option>' + c + '</option>').join('') + '</select></div>' +
      '<div class="fld"><label>金额（元）*</label><input id="exp-amt" type="number" inputmode="decimal" placeholder="填多少钱" style="height:50px;width:100%;border:2px solid var(--ink);border-radius:10px;background:#fff;padding:0 12px;font-size:16px"></div>' +
      '<div class="fld"><label>备注</label><input id="exp-note" placeholder="如：这个月水电费" style="height:50px;width:100%;border:2px solid var(--ink);border-radius:10px;background:#fff;padding:0 12px;font-size:16px"></div>' +
      '<button id="exp-go" class="okbtn" style="width:100%;height:56px;border:3px solid var(--ink);border-radius:12px;background:var(--green);color:#fff;font-size:18px;font-weight:900">记支出</button>'
    app.appendChild(form)
    document.getElementById('exp-go').onclick = submit
  }

  async function submit() {
    const amt = parseFloat(document.getElementById('exp-amt').value)
    if (!amt || amt <= 0) { toast('填个金额'); return }
    const cat = document.getElementById('exp-cat').value
    const note = document.getElementById('exp-note').value
    try {
      await api('expense:create', {
        category: cat,
        amount: Math.round(amt * 100),
        method: '现金',
        note: note,
        expense_date: new Date().toLocaleDateString('en-CA'),
        operator: '手机',
      })
      toast('已记支出 ' + amt.toFixed(2) + ' 元')
      document.getElementById('exp-amt').value = ''
      document.getElementById('exp-note').value = ''
    } catch (e) { toast('记支出失败: ' + e.message) }
  }

  render()
})
