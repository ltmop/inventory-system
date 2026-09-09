// pos.js: 开单页 —— 扫码/搜索/热销榜 → 购物车 → 贴纸四键结账 → 收讫印章
page('pos', function (app) {
  const cart = []
  let hotProducts = []
  let busy = false
  let searchTimer = null

  // 操作员：谁在开单记谁（getOperator/setOperator 已提升到 app.js 全局，各页共用）

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

    // P1-3 语音开单大按钮：说一整单（"伊势尼6号钩拿两包，收了10现金"）→ 确认卡 → 进清单
    const vorder = document.createElement('button')
    vorder.className = 'scanbtn'
    vorder.style.cssText = 'width:calc(100% - 36px);margin:8px 18px 0;height:54px;background:linear-gradient(135deg,#c9a55a,#d4af37);border-color:#c9a55a;color:#0a1628;font-size:17px;font-weight:900'
    vorder.innerHTML = '🎤 语音开单 · 说一整单'
    vorder.onclick = () => voiceOrderInput()
    app.appendChild(vorder)

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
          '<div class="qty"><button onclick="void(0)">−</button><span class="n" data-edit="1" style="cursor:pointer">' + c.qty + unitLabel + '</span><button onclick="void(0)">+</button></div>' +
          '<button data-del="1" title="移除" style="border:none;background:transparent;color:var(--sub);font-size:20px;margin-left:2px;cursor:pointer">✕</button>'
        // 点数量弹输入框精确改：米商品能填小数（15.5 米），件商品整数
        line.querySelector('[data-edit]').onclick = () => editQty(c)
        line.querySelectorAll('button')[0].onclick = () => {
          c.qty = Math.round((c.qty - step) * 10) / 10
          if (c.qty <= 0) cart.splice(cart.indexOf(c), 1)
          render()
        }
        line.querySelectorAll('button')[1].onclick = () => { c.qty = Math.round((c.qty + step) * 10) / 10; render() }
        const delBtn = line.querySelector('[data-del]'); if (delBtn) delBtn.onclick = () => { cart.splice(cart.indexOf(c), 1); render() }
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
      await api('inbound:create', { productId: r.id, quantity: qty, costPrice: cost, location: '', operator: getOperator() })
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

  // 后端 outbound:checkout 会用 {ok:false} 作 RESULT 返回拦截（库存不足/过期），这里统一上浮成中文提示
  function blockMsg(r) {
    if (!r) return '未通过'
    if (r.error) return r.error
    if (r.shortages && r.shortages.length) return '库存不足：' + r.shortages.map((s) => (s.name || ('#' + s.productId)) + ' 缺 ' + s.shortage).join('，')
    if (r.expired) return '单里含已过期批次，请处理后再开单'
    return '未通过'
  }

  // 幂等键：同一次结算(同一购物车)重试复用同一 key → 服务端判重防重复扣库存/记账；换单(购物车清空/变更)重新生成
  let checkoutIdKey = null
  function idemFor() { if (!checkoutIdKey) checkoutIdKey = String(Date.now()) + '-' + Math.random().toString(36).slice(2); return checkoutIdKey }

  async function checkout(method) {
    if (cart.length === 0 || busy) return
    busy = true; render()
    try {
      // 后端 confirmCheckout 字段是 camelCase：productId/sellingPrice/payMethod
      const r = await api('outbound:checkout', {
        items: cart.map(c => ({ productId: c.product_id, quantity: c.qty, sellingPrice: c.selling_price })),
        payMethod: method, operator: getOperator(), idempotencyKey: idemFor(),
      })
      if (r && r.ok === false) { toast('开单被拦截：' + blockMsg(r)); return }
      const totalFen = cart.reduce((s, c) => s + c.selling_price * c.qty, 0)
      showStamp('收讫', fmt(totalFen) + ' · ' + method, false)
      cart.length = 0
      checkoutIdKey = null
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
          const r = await api('outbound:checkout', {
            items: cart.map(c => ({ productId: c.product_id, quantity: c.qty, sellingPrice: c.selling_price })),
            operator: getOperator(),
            customerId: customer.id, paidAmount: 0, idempotencyKey: idemFor(),
          })
          if (r && r.ok === false) { toast('赊账被拦截：' + blockMsg(r)); return }
          showStamp('已赊', fmt(totalFen) + ' · ' + customer.name, false)
          cart.length = 0
          checkoutIdKey = null
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

  // ========== P1-3 语音开单（手机端：音频走局域网到店里电脑识别，不出店） ==========
  // 链路：录音(webm) → 16k PCM base64 → voice:parseOrderAudio（离线识别+热词+解析）
  //      本地模型没下载 → speechToText 云端兜底出文本 → voice:parseOrderAudio(text)
  // 铁律：确认卡不确认不落库；402/断网/识别失败 → 识别文本填搜索框，不白识别。

  // Float32 数组 → base64（PCM 原始字节）
  function pcmToBase64(arr) {
    const u8 = new Uint8Array(new Float32Array(arr).buffer)
    let bin = ''
    for (let i = 0; i < u8.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)))
    }
    return btoa(bin)
  }

  async function voiceOrderParse(blob) {
    // 1) 本地离线一条龙（识别带店里商品热词偏置，最准）
    try {
      const status = await api('voice:status')
      if (status && status.ready) {
        const pcm = await blobToPcm16k(blob)
        if (pcm.length > 0) {
          const r = await api('voice:parseOrderAudio', { audioBase64: pcmToBase64(pcm), sampleRate: 16000 })
          if (r) return r
        }
      }
    } catch { /* 本地失败 → 云端出文本 */ }
    // 2) 云端 ASR 只出文本，解析仍在店里电脑
    const asr = await speechToText(blob)
    if (asr && asr.text) {
      try { return await api('voice:parseOrderAudio', { text: asr.text }) } catch (e) { return { ok: false, reason: e.message, text: asr.text } }
    }
    return null
  }

  function voiceOrderInput() {
    const hasMic = !!(window.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    if (!hasMic) { toast('这个网络不支持手机录音（要用语音请连 HTTPS 或在电脑上说话）'); return }
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.96);z-index:400;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#e6edf5'
    overlay.innerHTML =
      '<div style="font-size:20px;font-weight:800;margin-bottom:6px">语音开单</div>' +
      '<div style="font-size:14px;color:#8fa3c0;margin-bottom:30px;padding:0 24px;text-align:center">说一整单，比如：伊势尼6号钩拿两包，收了10现金</div>' +
      '<div id="vo-mic" style="width:130px;height:130px;border-radius:50%;background:linear-gradient(135deg,#c9a55a,#d4af37);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 30px rgba(212,175,55,.4)">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="#0a1628" stroke-width="2" width="56" height="56"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM5 10a7 7 0 0 0 14 0M12 17v4"/></svg>' +
      '</div>' +
      '<div id="vo-status" style="margin-top:24px;font-size:16px;color:#8fa3c0">点麦克风开始</div>' +
      '<button id="vo-close" style="margin-top:30px;height:48px;padding:0 30px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px">取消</button>'
    document.body.appendChild(overlay)
    overlay.querySelector('#vo-close').onclick = () => { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); overlay.remove() }

    let recording = false
    const micBtn = overlay.querySelector('#vo-mic')
    const statusEl = overlay.querySelector('#vo-status')
    micBtn.onclick = () => {
      if (recording) { if (mediaRecorder) mediaRecorder.stop(); return }
      mediaChunks = []
      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        mediaRecorder = new MediaRecorder(stream)
        mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) mediaChunks.push(e.data) }
        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop())
          recording = false
          const blob = new Blob(mediaChunks, { type: 'audio/webm' })
          statusEl.textContent = '识别开单中...'
          const r = await voiceOrderParse(blob)
          overlay.remove()
          if (r && r.ok && !r.degraded && r.items && r.items.length > 0) { openVoiceOrderCard(r); return }
          // 降级铁律：识别文本回填搜索框手动开单，不白识别
          const t = (r && r.text) || ''
          const searchEl = document.querySelector('.search')
          if (t && searchEl) { searchEl.value = t; handleSearch(t); toast(r && r.failReason === 'quota-exceeded' ? 'AI 额度不足，已转成文字搜索' : 'AI 暂不可用，已转成文字搜索') }
          else toast('没听清，再说一次或手动开单')
        }
        mediaRecorder.start()
        recording = true
        statusEl.textContent = '正在听... 再点一次结束'
      }).catch(() => { statusEl.textContent = '麦克风打不开，检查权限' })
    }
  }

  // 语音开单确认卡：逐项核对（未命中的标红手选候选），确认后才进购物清单
  function openVoiceOrderCard(draft) {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.97);z-index:400;display:flex;flex-direction:column;padding:20px;color:#e6edf5'
    const bill = draft.billing && draft.billing.usage
      ? 'AI 理解消耗 ' + (draft.billing.usage.total_tokens || 0) + ' token' + (draft.billing.remaining != null ? '，余额剩 ' + draft.billing.remaining : '')
      : '纯本地匹配，未消耗 AI 额度'
    overlay.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
        '<div style="font-size:20px;font-weight:800">语音开单 · 请核对</div>' +
        '<button id="voc-close" style="width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:20px">✕</button>' +
      '</div>' +
      (draft.text ? '<div style="font-size:13px;color:#8fa3c0;margin-bottom:10px">识别原文：“' + draft.text + '”</div>' : '') +
      '<div id="voc-list" style="flex:1;overflow:auto"></div>' +
      '<div style="font-size:12px;color:#8fa3c0;margin:8px 0">' + bill + '</div>' +
      '<button id="voc-ok" style="height:56px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:18px;font-weight:900">确认加入清单</button>'
    document.body.appendChild(overlay)
    overlay.querySelector('#voc-close').onclick = () => overlay.remove()

    const listBox = overlay.querySelector('#voc-list')
    const okBtn = overlay.querySelector('#voc-ok')
    // 行状态：productId 为 null 的行必须手选候选才能确认（防幻觉：只能选候选集内的）
    const rows = draft.items.map((it) => ({ productId: it.productId, name: it.name, qty: it.qty, matchedBy: it.matchedBy, candidates: it.candidates || [], product: null }))

    async function hydrate() {
      // 一次拉全量商品建 id → 商品映射（product:search 不支持按 id 查，别用）
      let byId = {}
      try {
        const all = await api('product:list', { limit: 1000 })
        ;(all || []).forEach((p) => { byId[p.id] = p })
      } catch { /* 拉取失败：行里只显示名字 */ }
      rows.forEach((r) => { if (r.productId != null && byId[r.productId]) r.product = byId[r.productId] })
      paint()
    }

    function paint() {
      listBox.innerHTML = ''
      rows.forEach((r, idx) => {
        const row = document.createElement('div')
        row.style.cssText = 'padding:12px 14px;border-radius:10px;margin-bottom:8px;background:' + (r.productId != null ? 'rgba(255,255,255,.08)' : 'rgba(255,107,107,.15);border:1px solid #ff6b6b')
        if (r.productId != null) {
          row.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
              '<div style="font-size:16px;font-weight:700">' + (r.product ? prodName(r.product) : r.name) + (r.matchedBy === 'llm' ? ' <span style="font-size:11px;color:#c9a55a">AI匹配</span>' : '') + '</div>' +
              '<div style="font-size:15px;color:#c9a55a;font-weight:800">× ' + r.qty + '</div>' +
            '</div>' +
            '<div style="font-size:13px;color:#8fa3c0;margin-top:4px">' + (r.product ? fmt(r.product.suggest_price) + ' · 库存 ' + (r.product.total_stock || 0) : '加载中...') + '</div>'
        } else {
          row.innerHTML = '<div style="font-size:14px;color:#ff6b6b;font-weight:700;margin-bottom:6px">没认准「' + r.name + '」×' + r.qty + '，点一下正确的商品：</div>'
          if (r.candidates.length > 0) {
            const btns = document.createElement('div')
            btns.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px'
            r.candidates.forEach((c) => {
              const b = document.createElement('button')
              b.style.cssText = 'padding:8px 12px;border-radius:8px;border:1px solid #c9a55a;background:transparent;color:#e6edf5;font-size:13px'
              b.textContent = c.name
              b.onclick = async () => {
                try {
                  const all = await api('product:list', { limit: 1000 })
                  const p = (all || []).find((x) => x.id === c.id)
                  rows[idx].productId = c.id
                  rows[idx].product = p || null
                  rows[idx].matchedBy = 'manual'
                  paint()
                } catch { toast('加载商品失败') }
              }
              btns.appendChild(b)
            })
            row.appendChild(btns)
          } else {
            row.innerHTML += '<div style="font-size:13px;color:#8fa3c0">店里没有相近商品，这行不会进清单</div>'
          }
        }
        listBox.appendChild(row)
      })
      const unresolved = rows.filter((r) => r.productId == null && r.candidates.length > 0).length
      const usable = rows.filter((r) => r.productId != null && r.product).length
      okBtn.disabled = unresolved > 0 || usable === 0
      okBtn.style.opacity = okBtn.disabled ? '.5' : '1'
      okBtn.textContent = unresolved > 0 ? '还有 ' + unresolved + ' 行没认准商品' : '确认加入清单（' + usable + ' 项）'
    }

    okBtn.onclick = async () => {
      if (okBtn.disabled) return
      for (const r of rows) {
        if (r.productId == null || !r.product) continue
        const p = r.product
        const existing = cart.find((c) => c.product_id === p.id)
        let price = p.suggest_price
        if (!price) {
          const s = prompt('「' + prodName(p) + '」没设售价，卖多少钱？（元）', '')
          if (!s || !(parseFloat(s) > 0)) { toast('「' + prodName(p) + '」没售价，这行跳过'); continue }
          price = Math.round(parseFloat(s) * 100)
        }
        if (existing) existing.qty = Math.round((existing.qty + r.qty) * 10) / 10
        else cart.push({ product_id: p.id, product: p, qty: r.qty, selling_price: price })
      }
      overlay.remove()
      render()
      // 收款意图只做提示，结账仍走下面四个收款键（口径不变）
      if (draft.credit) toast('已加入清单，记得点「赊账」键选客户')
      else if (draft.payMethod) toast('已加入清单，点「' + draft.payMethod + '」键收款')
      else toast('已加入清单')
    }

    paint()
    hydrate()
  }

  render()
})
