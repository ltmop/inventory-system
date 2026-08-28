// pos.js: 开单页 —— 扫码/搜索/热销榜 → 购物车 → 贴纸四键结账 → 收讫印章
page('pos', function (app) {
  const cart = []
  let hotProducts = []
  let busy = false
  let searchTimer = null

  // 操作员：谁在开单记谁（本地记住，换班点名字切）
  const LS_OP = 'fi-operator'
  function getOperator() { try { return localStorage.getItem(LS_OP) || '老板' } catch { return '老板' } }
  function setOperator(n) { try { localStorage.setItem(LS_OP, n) } catch {} }

  loadHot()

  async function loadHot() {
    try {
      hotProducts = await api('report:hotSellers', { days: 30 })
      // 没设建议售价的货不上热销榜——否则按进价卖会倒贴钱
      hotProducts = (hotProducts || []).filter((p) => p.suggest_price > 0)
    } catch { hotProducts = [] }
    render()
  }

  function render() {
    app.innerHTML = ''

    // 扫码 + 搜索 + 语音
    const scanrow = document.createElement('div'); scanrow.className = 'scanrow'
    const scanbtn = document.createElement('button'); scanbtn.className = 'scanbtn'
    scanbtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M4 12h16"/></svg>扫 码'
    scanbtn.onclick = () => openScanner(handleScan, '扫条码或手输商品')
    const search = document.createElement('input'); search.className = 'search'; search.placeholder = '打字搜：品名 / 型号 / 条码'
    search.oninput = function (e) {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        const kw = e.target.value.trim()
        if (kw.length >= 2) handleSearch(kw)
      }, 300)
    }
    const mic = document.createElement('button'); mic.className = 'scanbtn'; mic.style.flex = '0 0 56px'; mic.style.height = '60px'
    mic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="26" height="26"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM5 10a7 7 0 0 0 14 0M12 17v4"/></svg>'
    mic.onclick = () => voiceInput((text) => { if (text) { smartVoiceSearch(text, (t) => { if (t) { search.value = t; handleSearch(t) } }) } }, '说商品名，比如：伊势尼 8号钩')
    scanrow.appendChild(scanbtn); scanrow.appendChild(search); scanrow.appendChild(mic)
    app.appendChild(scanrow)

    // 操作员：谁在开单（多人换班时点名字切换），出库流水记这个名
    const opRow = document.createElement('div'); opRow.className = 'hint'
    opRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 18px 0'
    const opName = getOperator()
    opRow.innerHTML = '<span style="color:var(--sub)">操作员：</span>' +
      '<button id="op-btn" style="border:2px solid var(--ink);background:var(--card);border-radius:8px;padding:2px 10px;font-size:14px;font-weight:800;color:var(--ink)">' + opName + '</button>' +
      '<span style="font-size:11px;color:var(--sub)">点名字换人</span>'
    app.appendChild(opRow)
    opRow.querySelector('#op-btn').onclick = () => {
      const v = prompt('操作员名字？（换班谁开单记谁）', opName)
      if (v && v.trim()) { setOperator(v.trim()); opRow.querySelector('#op-btn').textContent = v.trim() }
    }

    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = '人多时直接点下面热销榜，不用搜索'
    app.appendChild(hint)

    // 搜索结果面板（搜索出商品时展示，点选加入购物车）
    const resultBox = document.createElement('div'); resultBox.id = 'pos-results'
    app.appendChild(resultBox)

    // 热销榜
    if (hotProducts.length > 0) {
      const title = document.createElement('div'); title.className = 'sectitle'
      title.innerHTML = '<span class="tag">本店热销</span><span>近30天卖得最多 · 点图加单</span>'
      app.appendChild(title)
      const grid = document.createElement('div'); grid.className = 'grid'
      hotProducts.forEach(p => {
        const card = document.createElement('div'); card.className = 'hot'; card.onclick = () => addToCart(p)
        const inCart = cart.filter(c => c.product_id === p.id).reduce((s, c) => s + c.qty, 0)
        card.innerHTML = (inCart > 0 ? '<div class="badge">' + inCart + '</div>' : '') +
          '<div class="ph" style="background:' + phColor(p) + '">' + phChar(p) + '</div>' +
          '<div class="nm">' + prodName(p) + '</div>' +
          '<div class="pr">' + fmt(p.suggest_price) + '</div>'
        grid.appendChild(card)
      })
      app.appendChild(grid)
    }

    // 购物车
    const cartDiv = document.createElement('div'); cartDiv.className = 'cart'
    cartDiv.innerHTML = '<h3>购物清单</h3>'
    if (cart.length === 0) {
      cartDiv.innerHTML += '<div class="empty">扫码或点热销榜加商品</div>'
    } else {
      cart.forEach(c => {
        const name = prodName(c.product)
        const isMeter = c.product.unit === '米'
        const step = isMeter ? 0.5 : 1
        const unitLabel = isMeter ? '米' : ''
        const line = document.createElement('div'); line.className = 'line'
        line.innerHTML =
          '<div class="ph" style="background:' + phColor(c.product) + '">' + phChar(c.product) + '</div>' +
          '<div class="info"><div class="n">' + name + '</div><div class="p">' + fmt(c.selling_price) + (isMeter ? '/米' : '/件') + '</div></div>' +
          '<div class="qty"><button onclick="void(0)">−</button><span class="n" data-edit="1" style="cursor:pointer">' + c.qty + unitLabel + '</span><button onclick="void(0)">+</button></div>'
        // 点数量弹输入框精确改：米商品能填小数（15.5 米），件商品整数
        line.querySelector('[data-edit]').onclick = () => editQty(c)
        line.querySelectorAll('button')[0].onclick = () => {
          c.qty = Math.round((c.qty - step) * 10) / 10
          if (c.qty <= 0) cart.splice(cart.indexOf(c), 1)
          render()
        }
        line.querySelectorAll('button')[1].onclick = () => { c.qty = Math.round((c.qty + step) * 10) / 10; render() }
        cartDiv.appendChild(line)
      })
    }
    app.appendChild(cartDiv)

    // 结账
    const totalFen = cart.reduce((s, c) => s + c.selling_price * c.qty, 0)
    const chk = document.createElement('div'); chk.className = 'checkout'
    chk.innerHTML = '<div class="total"><span class="t">合计</span><span class="v">' + fmt(totalFen) + '</span></div>' +
      '<div class="payrow">' +
        '<button class="pay cash">现金</button>' +
        '<button class="pay wx">微信</button>' +
        '<button class="pay ali">支付宝</button>' +
        '<button class="pay credit">赊账</button>' +
      '</div>'
    if (!busy && cart.length > 0) {
      chk.querySelector('.pay.cash').onclick = () => checkout('现金')
      chk.querySelector('.pay.wx').onclick = () => payWithQr('微信')
      chk.querySelector('.pay.ali').onclick = () => payWithQr('支付宝')
      chk.querySelector('.pay.credit').onclick = () => creditCheckout()
    }
    app.appendChild(chk)
  }

  // 点购物车数量 → 弹输入框精确改：允许小数单位可填小数，其余必须是整数
  function editQty(c) {
    const isMeter = c.product.unit === '米'
    const v = prompt(
      isMeter ? '「' + prodName(c.product) + '」卖几米？' : '「' + prodName(c.product) + '」卖几个？',
      String(c.qty),
    )
    if (v === null) return
    const n = parseFloat(v)
    if (isMeter) {
      const rounded = Math.round(n * 10) / 10
      if (!(n > 0) || Math.abs(rounded - n) > 1e-9) { toast('米数要大于 0，最多 1 位小数'); return }
      c.qty = rounded
    } else {
      if (!Number.isInteger(n) || n <= 0) { toast('件数要是 ≥1 的整数'); return }
      c.qty = n
    }
    render()
  }

  async function addToCart(p) {
    const existing = cart.find(c => c.product_id === p.id)
    const isMeter = p.unit === '米'
    if (existing) {
      // 米商品步进 0.5，件商品步进 1
      existing.qty = isMeter ? Math.round((existing.qty + 0.5) * 10) / 10 : existing.qty + 1
      render(); return
    }
    let price = p.suggest_price
    // 没设售价的货必须现场填售价，不按进价兜底卖（不然倒贴钱）
    if (!price) {
      const s = prompt('「' + prodName(p) + '」没设售价，卖多少钱？（元）', '')
      if (!s || !(parseFloat(s) > 0)) { toast('得填个售价才能卖'); return }
      price = Math.round(parseFloat(s) * 100)
    }
    let qty = 1
    if (isMeter) {
      // 按斤/米等小数单位卖：直接填小数（如 1.5 斤）
      const s = prompt('「' + prodName(p) + '」卖多少米？', '1')
      const n = s ? parseFloat(s) : NaN
      if (!(n > 0)) { toast('得填个米数'); return }
      qty = Math.round(n * 10) / 10
    }
    cart.push({ product_id: p.id, product: p, qty, selling_price: price })
    render()
  }

  async function handleScan(code) {
    if (!code) return
    try {
      const rows = await api('product:search', { keyword: code })
      if (!rows || rows.length === 0) {
        const p = await createOnTheFly(code); if (p) await addToCart(p); return
      }
      await addToCart(rows[0])
    } catch (e) { toast('查找失败: ' + e.message) }
  }

  async function handleSearch(kw) {
    try {
      const rows = await api('product:search', { keyword: kw })
      const box = document.getElementById('pos-results')
      if (!box) return
      box.innerHTML = ''
      if (!rows || rows.length === 0) {
        // 没搜到 → 给"建档卖货"入口
        box.innerHTML =
          '<div style="padding:6px 16px">' +
            '<div class="text-sm text-muted" style="margin-bottom:8px">没找到「' + kw + '」，可以现场建档卖：</div>' +
            '<button class="scanbtn" id="create-sell" style="width:100%;height:52px;background:var(--gold);border-color:var(--gold)">➕ 建档卖「' + kw + '」</button>' +
          '</div>'
        const btn = document.getElementById('create-sell')
        if (btn) btn.onclick = async () => { const p = await createOnTheFly(kw); if (p) await addToCart(p) }
        return
      }
      // 有结果 → 列表展示，点选加入购物车（不自动加第一个）
      rows.forEach(p => {
        const isHot = p.is_hot === 1
        const isClear = p.is_clearance === 1
        const badges = (isHot ? '<span style="background:#ff6b6b;color:#fff;border-radius:3px;padding:0 4px;font-size:11px;font-weight:800">🔥热销</span> ' : '') +
          (isClear ? '<span style="background:#f59e0b;color:#fff;border-radius:3px;padding:0 4px;font-size:11px;font-weight:800">🏷处理</span> ' : '')
        const row = document.createElement('div'); row.className = 'card'; row.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0 16px 8px;padding:10px 14px;cursor:pointer'
        row.innerHTML =
          '<div class="ph" style="width:44px;height:44px;border-radius:8px;background:' + phColor(p) + ';color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;flex:none">' + phChar(p) + '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="font-bold" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + badges + prodName(p) + '</div>' +
            '<div class="text-xs text-muted">' + (p.sku_code || '') + ' · 库存 ' + (p.total_stock || 0) + (isClear ? ' · <span style="color:#f59e0b;font-weight:800">处理货可讲价</span>' : '') + '</div>' +
          '</div>' +
          '<div class="text-right" style="flex:none">' +
            '<div class="text-red font-bold">' + fmt(p.suggest_price) + '</div>' +
          '</div>'
        row.onclick = () => { addToCart(p); box.innerHTML = '' }
        box.appendChild(row)
      })
    } catch { toast('搜索失败') }
  }

  async function createOnTheFly(code) {
    const name = prompt('这个商品叫什么名字？（选填）', code)
    if (!name) return null
    // 进价必须填真实的，不能瞎猜——否则毛利报表全是错的
    const costStr = prompt('进价多少元？（毛利就靠它算，别乱填）', '')
    if (!costStr || !(parseFloat(costStr) > 0)) { toast('得填个真实进价，毛利才算得准'); return null }
    const cost = Math.round(parseFloat(costStr) * 100)
    const priceStr = prompt('卖多少钱？（元）例如 85', '')
    const price = priceStr ? Math.round(parseFloat(priceStr) * 100) : 0
    // 通用版：建档问一句是否按小数单位卖（斤/米/公斤等称重/计量类），确定则按"斤"（可在单位管理改）
    const isMeter = confirm('这个商品按斤/米等称重卖吗？（确定=按"斤"可开小数，取消=按个/件整数卖）')
    const category = '其他'
    const unit = isMeter ? '斤' : '件'
    try {
      const r = await api('product:create', {
        sku_code: code, barcode: code, category, brand: '', model: name,
        cost_price: cost, suggest_price: price, status: '待盘点', unit,
      })
      const qty = parseFloat(prompt(isMeter ? '大概多少斤？不准没关系，以后盘点会校正' : '大概多少个？不准没关系，以后盘点会校正', '1')) || 1
      await api('inbound:create', { productId: r.id, quantity: qty, costPrice: cost, location: '', operator: '手机' })
      return { id: r.id, sku_code: code, brand: '', model: name, suggest_price: price, cost_price: cost, unit }
    } catch (e) { toast('新建失败: ' + e.message); return null }
  }

  // 微信/支付宝结账：先全屏展示收款码让顾客扫，到账后点"完成收款"再记账
  // （解决了"手机记了账但钱没实时对账"——有码可扫，对账有依据）
  async function payWithQr(method) {
    if (cart.length === 0 || busy) return
    const type = method === '微信' ? 'wx' : 'ali'
    let qrImg = null
    try { const q = await api('payment:getQr'); qrImg = q ? q[type] : null } catch { qrImg = null }

    const totalFen = cart.reduce((s, c) => s + c.selling_price * c.qty, 0)

    // 没配收款码 → 给两个选择：现金收款，或记住去电脑配码（不静默吞掉）
    if (!qrImg) {
      const confirmMsg = window.confirm('电脑上还没配' + method + '收款码，顾客没法扫这个码。\n\n点「确定」用现金收款，点「取消」取消这单。')
      if (confirmMsg) checkout('现金')
      return
    }

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:350;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;color:var(--ink)'
    overlay.innerHTML =
      '<div style="font-size:22px;font-weight:900;margin-bottom:6px">请顾客扫' + method + '收款码</div>' +
      '<div style="font-size:17px;color:var(--sub);margin-bottom:14px">应收 <b style="color:var(--ink)">' + fmt(totalFen) + '</b></div>' +
      '<div style="width:min(88vw,340px);background:#fff;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,.12);padding:10px">' +
        '<img src="' + qrImg + '" style="width:100%;height:auto;display:block;border-radius:8px">' +
      '</div>' +
      '<div style="margin-top:10px;font-size:14px;color:var(--sub)">请把屏幕调亮，让顾客扫</div>' +
      '<button id="qr-done" style="margin-top:18px;width:100%;max-width:340px;height:60px;border:none;border-radius:14px;background:var(--green);color:#fff;font-size:20px;font-weight:900">已完成收款</button>' +
      '<button id="qr-cancel" style="margin-top:10px;height:44px;border:none;background:transparent;color:var(--sub);font-size:15px">还没收到，取消</button>'
    document.body.appendChild(overlay)

    overlay.querySelector('#qr-cancel').onclick = () => overlay.remove()
    overlay.querySelector('#qr-done').onclick = () => { overlay.remove(); checkout(method) }
  }

  async function checkout(method) {
    if (cart.length === 0 || busy) return
    busy = true; render()
    try {
      // 后端 confirmCheckout 字段是 camelCase：productId/sellingPrice/payMethod
      await api('outbound:checkout', {
        items: cart.map(c => ({ productId: c.product_id, quantity: c.qty, sellingPrice: c.selling_price })),
        payMethod: method, operator: getOperator(),
      })
      const totalFen = cart.reduce((s, c) => s + c.selling_price * c.qty, 0)
      showStamp('收讫', fmt(totalFen) + ' · ' + method, false)
      cart.length = 0
    } catch (e) { toast('结账失败: ' + e.message) } finally { busy = false; render() }
  }

  async function creditCheckout() {
    if (cart.length === 0 || busy) return
    try {
      const list = await api('customer:list')
      openCustomerPanel(list, async (customer) => {
        busy = true; render()
        const totalFen = cart.reduce((s, c) => s + c.selling_price * c.qty, 0)
        try {
          await api('outbound:checkout', {
            items: cart.map(c => ({ productId: c.product_id, quantity: c.qty, sellingPrice: c.selling_price })),
            operator: getOperator(),
            customerId: customer.id, paidAmount: 0,
          })
          showStamp('已赊', fmt(totalFen) + ' · ' + customer.name, false)
          cart.length = 0
        } catch (e) { toast('赊账失败: ' + e.message) }
        finally { busy = false; render() }
      })
    } catch (e) { toast('加载客户失败: ' + e.message) }
  }

  // 客户选择面板：点选老客户，或新建客户（不用手打字找）
  function openCustomerPanel(list, onSelect) {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.95);z-index:300;display:flex;flex-direction:column;padding:20px;color:#e6edf5'
    overlay.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
        '<div style="font-size:20px;font-weight:700">赊给谁？</div>' +
        '<button id="cust-close" style="width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:20px">✕</button>' +
      '</div>' +
      '<div id="cust-list" style="flex:1;overflow:auto"></div>' +
      '<button id="cust-new" style="height:56px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:18px;font-weight:800;margin-top:10px">➕ 新建客户</button>'
    document.body.appendChild(overlay)
    document.getElementById('cust-close').onclick = () => overlay.remove()
    const listBox = document.getElementById('cust-list')
    if (list.length > 0) {
      listBox.innerHTML = list.map(c =>
        '<div data-cust="' + c.id + '" style="padding:14px 16px;border-radius:10px;background:rgba(255,255,255,.08);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">' +
          '<div style="font-size:18px;font-weight:700">' + c.name + '</div>' +
          (c.outstanding > 0 ? '<div style="color:#ff6b6b;font-weight:700">欠 ' + fmt(c.outstanding) + '</div>' : '<div style="color:#4ade80">无欠款</div>') +
        '</div>'
      ).join('')
      listBox.querySelectorAll('[data-cust]').forEach(el => {
        el.onclick = () => {
          const c = list.find(x => x.id === Number(el.getAttribute('data-cust')))
          if (c) { overlay.remove(); onSelect(c) }
        }
      })
    } else {
      listBox.innerHTML = '<div style="padding:10px;color:#8fa3c0">还没有客户，点下面新建</div>'
    }
    document.getElementById('cust-new').onclick = async () => {
      const name = prompt('新客户名字？')
      if (!name) return
      try {
        const r = await api('customer:create', { name, phone: '', notes: '' })
        overlay.remove()
        onSelect({ id: r.id, name })
      } catch (e) { toast('建客户失败: ' + e.message) }
    }
  }

  // 从库存页点商品跳过来：自动把该商品加进购物车
  try {
    const preselectId = localStorage.getItem('fi-pos-preselect')
    if (preselectId) {
      localStorage.removeItem('fi-pos-preselect')
      api('product:search', { keyword: String(preselectId) }).then((rows) => {
        if (rows && rows.length > 0) addToCart(rows[0])
      }).catch(() => {})
    }
  } catch { /* localStorage 不可用忽略 */ }

  render()
})
