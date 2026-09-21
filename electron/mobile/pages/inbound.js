// inbound.js: 入库页 —— 拍照建档 / 扫码入库 双入口 → 已入库印章

// 分类/单位兜底清单：服务端 category:list / unit:list 拉不到时（弱网、离线、老服务器）也不让下拉空着。
// 口径与服务端一致 —— 单位里 1 = 允许小数（units.allow_decimal），数量步进按它走。
const FI_CATEGORY_FALLBACK = ['饵料', '鱼钩', '鱼线', '浮漂', '铅坠', '鱼竿', '渔轮', '路亚假饵', '小药', '活饵', '工具配件', '收纳包具', '灯具', '其他']
const FI_UNIT_FALLBACK = [
  ['件', 0], ['个', 0], ['包', 0], ['瓶', 0], ['盒', 0], ['袋', 0], ['箱', 0], ['桶', 0], ['盘', 0],
  ['把', 0], ['根', 0], ['支', 0], ['条', 0], ['套', 0], ['副', 0], ['双', 0], ['张', 0], ['台', 0], ['辆', 0], ['块', 0],
  ['斤', 1], ['公斤', 1], ['千克', 1], ['克', 1], ['米', 1], ['卷', 1],
]

page('inbound', function (app) {
  let recentInbounds = []
  let lowStock = []            // 低于警戒线的货（凑成入库页下半屏的「待补货」清单）
  let justAdded = 0            // 刚入库的行数（用来做高亮）
  let pendingPhoto = null // 已选好、还没入库的商品图（base64）；入库拿到 id 后再挂到商品上
  loadRecents()

  // newItems：刚入库的那几行，直接插到列表最上面并高亮 —— 老板要"新建档的商品出现在下面空白处"
  async function loadRecents(newItems) {
    try {
      const tx = await api('report:today')
      recentInbounds = (tx.recent || []).filter(t => t.type === 'in').slice(0, 10)
    } catch { recentInbounds = [] }
    if (Array.isArray(newItems) && newItems.length) {
      recentInbounds = newItems.concat(recentInbounds).slice(0, 10)
      justAdded = newItems.length
    }
    render()
    if (Array.isArray(newItems) && newItems.length) {
      // 滚到刚入库的位置，让人一眼看到"进去了"
      setTimeout(function () {
        const el = document.querySelector('.rec.new') || document.getElementById('recent-inbound')
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }, 120)
    }
  }

  // 「待补货」清单：原来这一页下面有 724px（占屏 31%）一片死白 —— 老板原话
  // "入库下面的空白页太多了"。这里把它换成真数据：低于警戒线的货按最缺的排前面，
  // 每行一个「补货」键，点完直接走原来的入库流程，补完就从清单里消失。
  async function loadLowStock() {
    try { lowStock = (await api('report:lowStock')) || [] } catch (e) { lowStock = [] }
    renderRestock()
  }

  function renderRestock() {
    const box = document.getElementById('inbound-restock')
    if (!box) return
    box.innerHTML = ''
    const card = document.createElement('div'); card.className = 'restock'
    if (!lowStock.length) {
      card.innerHTML = '<div class="rh"><span class="rt">' + FiIcon('check', 15) + '库存都够卖</span>' +
        '<span style="font-size:calc(var(--s)*11.5px);color:var(--sub)">没有低于警戒线的货</span></div>'
      box.appendChild(card)
      return
    }
    const head = document.createElement('div'); head.className = 'rh'
    head.innerHTML = '<span class="rt">' + FiIcon('alert', 15) + '待补货<span class="rn">' + lowStock.length + ' 种</span></span>' +
      '<span class="rm" id="rs-all">看全部' + FiIcon('chevron', 12) + '</span>'
    card.appendChild(head)
    const list = document.createElement('div'); list.className = 'rl'
    lowStock.slice(0, 80).forEach(function (p) {
      const name = ((p.brand || '') + ' ' + (p.model || '')).trim() || p.sku_code || ('商品 #' + p.id)
      const row = document.createElement('div'); row.className = 'rr'
      row.innerHTML = '<div class="rp">' + escHtml(name.charAt(0) || '?') + '</div>' +
        '<div class="ri2"><div class="rn2">' + escHtml(name) + '</div>' +
        '<div class="rd">库存 <b>' + (p.stock || 0) + '</b> · 警戒线 ' + (p.threshold || 5) + (p.location ? ' · ' + escHtml(p.location) : '') + '</div></div>' +
        '<button class="go">' + FiIcon('plus', 13) + '补货</button>'
      row.querySelector('.go').onclick = async function (e) {
        e.stopPropagation()
        // 复用扫码入库那条流程：查商品 → 填数量/进价/到期日 → 入库
        await onScan(p.sku_code || name)
        loadLowStock()          // 补过的货库存回线上，自己从清单里消失
      }
      list.appendChild(row)
    })
    card.appendChild(list)
    box.appendChild(card)
    const all = head.querySelector('#rs-all')
    if (all) all.onclick = function () {
      try { window.__fiStockLowOnly = true } catch (e) { /* 忽略 */ }
      location.hash = '#stock'
    }
    // AI 补货建议：把"最该先进哪几样"直接说成一句话（有数据才说，没数据不编）
    const advice = document.createElement('div')
    advice.className = 'rs-tip'
    advice.style.cssText = 'flex:none;padding:8px 13px 10px;border-top:1px solid var(--line2);line-height:1.7'
    advice.innerHTML = '最缺的是 <b style="color:var(--danger)">' + escHtml(((lowStock[0].brand || '') + ' ' + (lowStock[0].model || '')).trim()) + '</b>' +
      (lowStock.length > 1 ? '、' + escHtml(((lowStock[1].brand || '') + ' ' + (lowStock[1].model || '')).trim()) : '') +
      '；补完点右边「补货」就进账，库存页会跟着变。'
    card.appendChild(advice)
  }

  // ===== 进货单整单入库（老板要的：有单据就该按单据一次入完）=====
  async function noteFlow() {
    if (!window.FiPhoto) { toast('这一版没有拍照模块，更新后再试'); return }
    let b64 = null
    try { b64 = await FiPhoto.pickPhoto() } catch (e) { toast('读图失败：' + ((e && e.message) || '')); return }
    if (!b64) return
    toast('正在识别单据…（约 5-15 秒）')
    let r = null
    try { r = await api('ai:parseInboundNote', { imageBase64: b64, mimeType: 'image/jpeg' }) } catch (e) { toast('识别失败：' + ((e && e.message) || '')); return }
    if (!r || !r.ok || !Array.isArray(r.items) || !r.items.length) {
      const why = !r ? '没回应' : (r.reason === 'no-vision' ? '服务器没配视觉模型（找维护）' : r.reason === 'parse-failed' ? '单据没看清，换张更清晰、别反光的' : (r.reason || '没识别出商品行'))
      toast('识别失败：' + why)
      return
    }
    openNoteReview(r.items)
  }

  // 识别结果核对表：数量/进价可改、认错的行可删；确认后走 inbound:fromNote 一次入库
  function openNoteReview(items) {
    const rows = items.map(function (it) {
      return {
        product_id: it.product_id ? Number(it.product_id) : null,
        matched: !!it.product_id,
        matched_name: it.matched_name || '',
        brand: it.brand || '', model: it.model || '',
        category: it.category || '其他',
        unit: it.unit || '件',
        quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
        // 服务端 ai.js 给的是「分」：cost_price_fen（兼容旧字段 cost_price_yuan）
        cost_price: Math.max(0, Math.round(Number(it.cost_price_fen != null ? it.cost_price_fen : Number(it.cost_price_yuan || 0) * 100))),
      }
    })
    const ov = sheet('核对进货单（' + rows.length + ' 行）',
      '<div class="text-sm text-muted" style="margin-bottom:10px">AI 认出来的行。数量 / 进价可以改，认错的行点右边叉删掉；核对完点最下面「全部入库」。</div>' +
      '<div id="nt-rows"></div>' +
      '<div class="text-xs text-muted" id="nt-sum" style="margin:10px 0"></div>' +
      '<button id="nt-go" class="okbtn">全部入库</button>')
    const box = ov.querySelector('#nt-rows'), sumEl = ov.querySelector('#nt-sum')
    function draw() {
      box.innerHTML = ''
      rows.forEach(function (r, i) {
        const el = document.createElement('div')
        el.className = 'card'
        el.style.cssText = 'margin:0 0 8px;padding:10px'
        el.innerHTML =
          '<div class="flex" style="align-items:center;gap:8px">' +
            '<div style="flex:1;min-width:0">' +
              '<div class="font-bold" style="font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml((r.brand + ' ' + r.model).trim() || '（没认出名）') + '</div>' +
              '<div class="text-xs text-muted" style="margin-top:2px">' + escHtml(r.category) + ' · ' + (r.matched ? ('已有商品' + (r.matched_name ? '：' + escHtml(r.matched_name) : '')) : '新商品，会建档（售价按 进价×2）') + '</div>' +
            '</div>' +
            '<button data-x="' + i + '" style="flex:none;width:30px;height:30px;border-radius:50%;border:none;background:var(--danger-l);color:var(--danger);display:flex;align-items:center;justify-content:center">' + FiIcon('close', 14) + '</button>' +
          '</div>' +
          '<div class="flex" style="gap:8px;margin-top:8px">' +
            '<label style="flex:1"><span class="text-xs text-muted">数量</span><input data-q="' + i + '" type="number" step="0.1" value="' + r.quantity + '" style="width:100%;height:38px;border:1px solid var(--line);border-radius:9px;padding:0 9px;font-size:14px"></label>' +
            '<label style="flex:1"><span class="text-xs text-muted">进价（元）</span><input data-c="' + i + '" type="number" step="0.01" value="' + (r.cost_price / 100).toFixed(2) + '" style="width:100%;height:38px;border:1px solid var(--line);border-radius:9px;padding:0 9px;font-size:14px"></label>' +
          '</div>'
        box.appendChild(el)
      })
      box.querySelectorAll('[data-x]').forEach(function (b) { b.onclick = function () { rows.splice(Number(b.getAttribute('data-x')), 1); draw() } })
      box.querySelectorAll('[data-q]').forEach(function (inp) { inp.onchange = function () { rows[Number(inp.getAttribute('data-q'))].quantity = parseFloat(inp.value) || 0; draw() } })
      box.querySelectorAll('[data-c]').forEach(function (inp) { inp.onchange = function () { rows[Number(inp.getAttribute('data-c'))].cost_price = Math.round((parseFloat(inp.value) || 0) * 100); draw() } })
      const total = rows.reduce(function (s, r) { return s + r.cost_price * r.quantity }, 0)
      const news = rows.filter(function (r) { return !r.matched }).length
      sumEl.textContent = rows.length ? ('共 ' + rows.length + ' 行 · 进货金额 ' + fmt(total) + (news ? '（' + news + ' 行是新商品）' : '')) : '没有行了'
    }
    draw()
    ov.querySelector('#nt-go').onclick = async function () {
      const list = rows.filter(function (r) { return r.quantity > 0 }).map(function (r) {
        return { product_id: r.product_id, brand: r.brand, model: r.model, category: r.category, unit: r.unit, quantity: r.quantity, cost_price: r.cost_price }
      })
      if (!list.length) { toast('没有可入库的行'); return }
      const btn = ov.querySelector('#nt-go'); btn.disabled = true; btn.textContent = '正在入库…'
      try {
        const res = await api('inbound:fromNote', { items: list, operator: getOperator() })
        ov.remove()
        const msg = '入库 ' + (res.done || 0) + ' 行' + (res.created ? '（新建 ' + res.created + ' 个商品）' : '')
        toast(msg)
        showStamp('已入库', msg, true)
        if (res.failed && res.failed.length) {
          alert('这些行没入库成功：\n' + res.failed.map(function (f) { return '· ' + (f.brand || '') + ' ' + (f.model || '') + '：' + f.reason }).join('\n'))
        }
        loadRecents(rows.filter(function (r) { return r.quantity > 0 }).map(function (r) {
          return { brand: r.brand, model: r.model, quantity: r.quantity, timestamp: new Date().toISOString() }
        }))
      } catch (e) {
        btn.disabled = false; btn.textContent = '全部入库'
        toast('入库失败：' + ((e && e.message) || ''))
      }
    }
  }

  function render() {
    app.innerHTML = ''
    // 让「待补货」清单吃掉页面剩余高度（否则底下就是一大片空白）
    app.classList.add('fill')

    // 四个入口：AI拍照建档 / 手动建档 / 扫码入库 / 进货单整单入库
    const row = document.createElement('div'); row.className = 'bigrow'
    const photo = document.createElement('button'); photo.className = 'big photo'
    photo.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="26" height="26"><path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>AI 拍照建档'
    photo.onclick = photoFlow
    const manual = document.createElement('button'); manual.className = 'big'
    manual.style.borderColor = 'var(--gold)'; manual.style.color = 'var(--gold)'
    manual.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="26" height="26"><path d="M12 5v14M5 12h14"/></svg>手动建档'
    manual.onclick = () => showCreateForm('', null)
    const scan = document.createElement('button'); scan.className = 'big'
    scan.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="26" height="26"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M4 12h16"/></svg>扫码入库'
    scan.onclick = () => openScanner(onScan, '扫条码入库')
    // 进货单整单入库：拍一张单据 → AI 逐行识别 → 核对数量/进价 → 一次入库
    const note = document.createElement('button'); note.className = 'big'
    note.style.borderColor = 'var(--blue)'; note.style.color = 'var(--blue)'
    note.innerHTML = FiIcon('clipboard', 22) + '进货单入库'
    note.onclick = noteFlow
    row.appendChild(photo); row.appendChild(manual); row.appendChild(scan); row.appendChild(note)
    // 固定顶栏：入库入口与搜索钉在顶部，翻看最近入库时也能一键操作
    const sticky = document.createElement('div'); sticky.className = 'sticky-bar'
    sticky.appendChild(row)
    app.appendChild(sticky)

    // 搜索
    const searchDiv = document.createElement('div'); searchDiv.className = 'scanrow'
    const input = document.createElement('input'); input.className = 'search'; input.placeholder = '没有相机？打字搜或新建商品'
    input.style.width = '100%'; input.onchange = () => { const v = input.value.trim(); if (v) onScan(v) }
    searchDiv.appendChild(input)
    sticky.appendChild(searchDiv)

    // 建档表单（拍照或扫码后展开）
    const form = document.createElement('div'); form.className = 'form-card'; form.id = 'inbound-form'
    form.innerHTML =
      '<div class="ft"><b>新商品建档</b><span class="aitag" id="ai-tag">AI 已预填</span></div>' +
      '<div class="fld"><label>商品名称</label><input id="f-name" placeholder="例：农夫山泉 550ml"></div>' +
      '<div class="fldrow">' +
        // 分类/单位的 <option> 由 fiFillCategories / fiFillUnits 填（先兜底后拉服务端）；
        // 以前这里写死 <option>其他</option> 和「件/米」两个，所以老板永远只看到「其他」
        '<div class="fld"><label>分类</label><select id="f-cat"></select></div>' +
        '<div class="fld"><label>进价（元）</label><input id="f-cost" type="number" step="0.01" placeholder="0.00"></div>' +
      '</div>' +
      '<div class="fld"><label>售价（元）</label><input id="f-price" type="number" step="0.01" placeholder="卖多少钱？填了开单点一下就卖"></div>' +
      '<div class="fldrow">' +
        '<div class="fld"><label>计量单位</label><select id="f-unit"></select></div>' +
        '<div class="fld"><label>数量</label><input id="f-qty" type="number" step="1" placeholder="多少个 / 多少包？"></div>' +
      '</div>' +
      '<div class="fld"><label id="f-expiry-label">到期日（可选）</label><input id="f-expiry" type="date" placeholder="2026-12-31"></div>' +
      '<div class="fld"><label>商品照片（可选）</label>' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<img id="f-photo-prev" alt="商品照片" style="display:none;width:110px;height:110px;object-fit:cover;border-radius:10px;border:2px solid var(--ink);flex:none">' +
          '<button type="button" id="f-photo-btn" style="flex:1;height:46px;border-radius:10px;border:2px dashed var(--ink);background:var(--card);color:var(--ink);font-size:15px;font-weight:800">' + FiIcon('camera', 15) + ' 拍一张 / 从相册选</button>' +
        '</div>' +
      '</div>' +
      '<button class="okbtn" id="f-ok">完成入库</button>'
    app.appendChild(form)

    // 分类 / 单位：**先填兜底清单，再拉服务端真清单覆盖**（离线也不至于只剩一个「其他」）。
    // 旧代码这里写的是 invoke('category:list')，而 app.js 里根本没有 invoke 这个函数
    // （只有 api / invokeRaw）→ 抛 ReferenceError → 被下面的 try/catch 吞掉 →
    // 「动态分类」从上线起就从来没生效过，老板看到的永远是写死的「其他」。
    // 现在：①改用真函数 api() ②不再用裸 try/catch 静默吞错。
    const catSel = document.getElementById('f-cat')
    const unitSel = document.getElementById('f-unit')
    const qtyEl = document.getElementById('f-qty')
    fiFillCategories(catSel, null, FI_CATEGORY_FALLBACK)
    fiFillUnits(unitSel, null, FI_UNIT_FALLBACK)
    syncQtyStep()
    if (unitSel) unitSel.addEventListener('change', syncQtyStep)
    api('category:list').then((cats) => fiFillCategories(catSel, cats, FI_CATEGORY_FALLBACK)).catch(() => {})
    api('unit:list').then((units) => { fiFillUnits(unitSel, units, FI_UNIT_FALLBACK); syncQtyStep() }).catch(() => {})

    // 数量的步进跟着单位走：可小数单位（斤/公斤/千克/克/米/卷）按 0.1，其余按整数
    function syncQtyStep() {
      if (!qtyEl) return
      const dec = fiUnitAllowsDecimal(unitSel)
      const un = (unitSel && unitSel.value) || '件'
      qtyEl.step = dec ? '0.1' : '1'
      qtyEl.placeholder = dec ? ('多少' + un + '？可填小数') : ('多少个 / 多少' + un + '？')
      // 从可小数单位切到整数单位时，把已经填的小数抹平（2.5 包 → 2 包），不留一个非法值在框里
      if (!dec && qtyEl.value && String(qtyEl.value).indexOf('.') >= 0) {
        qtyEl.value = String(Math.floor(parseFloat(qtyEl.value) || 0))
      }
    }

    document.getElementById('f-ok').onclick = finishInbound

    // 商品照片：选好先本地预览，等入库建档拿到商品 id 再真正存（见 finishInbound）
    const photoBtn = document.getElementById('f-photo-btn')
    const photoPrev = document.getElementById('f-photo-prev')
    if (photoBtn) {
      photoBtn.onclick = async () => {
        try {
          const b64 = await FiPhoto.pickPhoto()
          if (!b64) return
          pendingPhoto = b64
          setPhotoPreview(b64)
        } catch (e) { toast('选图失败: ' + (e.message || '')) }
      }
    }

    // 今日入库记录（永远渲染：没有记录时给一句提示，不留一大片空白）
    {
      const recTitle = document.createElement('div'); recTitle.className = 'sectitle'
      recTitle.innerHTML = '<span class="tag" style="background:var(--ink)">今日入库</span><span>' +
        (recentInbounds.length ? ('最近 ' + recentInbounds.length + ' 条') : '还没有记录') + '</span>'
      app.appendChild(recTitle)
      const recs = document.createElement('div'); recs.id = 'recent-inbound'; recs.style.padding = '0 14px 10px'
      if (!recentInbounds.length) {
        // 不再用 26px 内边距的 .empty 撑出 110px 空白（下面那块「待补货」才是这半屏的主角）
        recs.innerHTML = '<div class="hint" style="padding:0">入库成功的货会一条条列在这里；今天还没进过货</div>'
      }
      recentInbounds.forEach((t, ti) => {
        const name = (t.brand || '') + ' ' + (t.model || '') || t.sku_code || '-'
        const time = fiHHMM(t.timestamp)
        const div = document.createElement('div'); div.className = 'rec' + (ti < justAdded ? ' new' : '')
        div.innerHTML =
          '<div class="ph" style="background:var(--green)">' + (name[0] || '?') + '</div>' +
          '<div class="info"><div class="n">' + name + '</div><div class="d">' + time + '</div></div>' +
          '<div class="q">+' + t.quantity + '</div>'
        recs.appendChild(div)
      })
      app.appendChild(recs)
    }

    // 待补货清单：塞满下半屏（数据是异步来的，先放容器再填）
    const restockBox = document.createElement('div'); restockBox.id = 'inbound-restock'
    restockBox.style.cssText = 'display:flex;flex-direction:column;min-height:0;flex:1 1 auto'
    app.appendChild(restockBox)
  }

  // 保质期商品品类：饵料/小药/活饵/路亚假饵 入库必填到期日（与电脑端 requiresExpiry 一致）
  const EXPIRY_REQUIRED_CATEGORIES = ['饵料', '小药', '活饵', '路亚假饵']

  // 日历点选到期日（替代手输，防输错）；required=true 时无"不要到期日"按钮（保质期商品）
  function promptDate(title, cb, required) {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.95);z-index:300;display:flex;flex-direction:column;justify-content:center;padding:24px;color:#e6edf5'
    const skipBtn = required
      ? ''
      : '<button id="date-skip" style="flex:1;height:50px;border-radius:12px;border:none;background:rgba(255,255,255,.12);color:#e6edf5;font-size:16px">不要到期日</button>'
    overlay.innerHTML =
      '<div style="font-size:18px;font-weight:700;margin-bottom:12px">' + title + (required ? '（必填）' : '') + '</div>' +
      '<input type="date" id="date-input" style="height:50px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:12px;color:#fff;font-size:18px;padding:0 12px;margin-bottom:14px;width:100%">' +
      '<div style="display:flex;gap:10px">' +
        '<button id="date-ok" style="flex:1;height:50px;border-radius:12px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:16px;font-weight:800">确定</button>' +
        skipBtn +
      '</div>'
    document.body.appendChild(overlay)
    if (!required) {
      document.getElementById('date-skip').onclick = () => { overlay.remove(); cb(null) }
    }
    document.getElementById('date-ok').onclick = () => {
      const v = document.getElementById('date-input').value
      overlay.remove()
      if (required && !v) { toast('必须选择到期日'); return }
      cb(v || null)
    }
  }

  async function onScan(code) {
    if (!code) return
    try {
      const rows = await api('product:search', { keyword: code })
      if (!rows || rows.length === 0) { showCreateForm(code, null); return }
      const p = rows[0]
      const name = prodName(p)
      // 允许小数单位入库小数；其余整数
      const isMeter = p.unit === '米'
      const qtyStr = prompt('「' + name + '」\n库存 ' + (p.total_stock || 0) + '，入多少' + (isMeter ? '米' : '个') + '？', '1')
      const qty = isMeter ? Math.round((parseFloat(qtyStr) || 0) * 10) / 10 : (parseInt(qtyStr, 10) || 0)
      if (!(qty > 0)) return
      const cost = prompt('进价多少元？', String((p.cost_price || 0) / 100))
      // 到期日：保质期商品（饵料/小药/活饵/路亚假饵）必填，与电脑端 requiresExpiry 同口径；其他可选
      const needExpiry = EXPIRY_REQUIRED_CATEGORIES.includes(p.category)
      promptDate('到期日（饵料/小药/活饵/路亚假饵填）', async (expiry) => {
        if (needExpiry && !expiry) { toast('保质期商品必须填到期日'); return }
        const payload = {
          productId: p.id, quantity: qty,
          costPrice: cost ? Math.round(parseFloat(cost) * 100) : p.cost_price,
          location: p.location || '', operator: getOperator(),
        }
        if (expiry) payload.expiryDate = expiry
        try {
          await api('inbound:create', payload)
          showStamp('已入库', name + ' × ' + qty, true)
          loadRecents([{ brand: p.brand, model: p.model, quantity: qty, timestamp: new Date().toISOString() }])
        } catch (e) { toast('入库失败: ' + e.message) }
      }, needExpiry)
    } catch (e) { toast('入库失败: ' + e.message) }
  }

  // 到期日标签联动：选中保质期品类时显示"必填"并变红，否则"可选"
  function updateExpiryLabel() {
    const cat = document.getElementById('f-cat').value
    const label = document.getElementById('f-expiry-label')
    if (!label) return
    const need = EXPIRY_REQUIRED_CATEGORIES.includes(cat)
    label.textContent = need ? '到期日（必填）' : '到期日（可选）'
    label.style.color = need ? '#ff6b6b' : ''
  }

  function showCreateForm(code, aiResult) {
    const form = document.getElementById('inbound-form')
    const aiTag = document.getElementById('ai-tag')
    document.getElementById('f-name').value = aiResult ? (aiResult.brand || '') + ' ' + (aiResult.model || '') : ''
    document.getElementById('f-cat').value = aiResult ? aiResult.category || '其他' : '其他'
    document.getElementById('f-cost').value = aiResult ? (aiResult.cost_price_yuan || '') : ''
    const priceEl0 = document.getElementById('f-price')
    if (priceEl0) priceEl0.value = aiResult ? (aiResult.selling_price_yuan || '') : ''
    document.getElementById('f-qty').value = aiResult && aiResult.quantity ? aiResult.quantity : ''
    // 到期日字段重置：清空上次的值
    const expiryEl = document.getElementById('f-expiry')
    if (expiryEl) expiryEl.value = ''
    // 商品照片也一起重置：每次建档重新选，免得上一张误挂到新商品上
    pendingPhoto = null
    const prevEl = document.getElementById('f-photo-prev')
    if (prevEl) { prevEl.removeAttribute('src'); prevEl.style.display = 'none' }
    const pbtn = document.getElementById('f-photo-btn')
    if (pbtn) pbtn.innerHTML = FiIcon('camera', 15) + ' 拍一张 / 从相册选'
    if (aiResult) { aiTag.classList.add('show') } else { aiTag.classList.remove('show') }
    form.classList.add('show')
    // 存 code 到临时属性
    form.setAttribute('data-code', code)
    updateExpiryLabel()
    document.getElementById('f-qty').focus()
  }

  // 品类下拉切换时联动到期日标签
  const catSelect = document.getElementById('f-cat')
  if (catSelect) catSelect.addEventListener('change', updateExpiryLabel)

  // 批量入库：把 AI 识别出的每个商品入进去（已匹配的直接入，没匹配的先建档再入）
  async function batchInbound(items) {
    let okCount = 0, failCount = 0
    const failNames = []
    for (const it of items) {
      const name = (it.brand || '') + ' ' + (it.model || '') || it.category || '商品'
      try {
        const qty = Math.round(Number(it.quantity))
        if (!(qty > 0)) { failCount++; failNames.push(name + '(数量无效)'); continue }
        const cost = Math.round(Number(it.cost_price_yuan || 0) * 100)
        let productId = it.product_id
        // 到期日：保质期商品（饵料/小药/活饵/路亚假饵）必填
        let expiry = undefined
        if (EXPIRY_REQUIRED_CATEGORIES.includes(it.category)) {
          const v = prompt('「' + name + '」是' + it.category + '，这批到期日？（YYYY-MM-DD）', '')
          if (!v) { failCount++; failNames.push(name + '(没填到期日)'); continue }
          expiry = v
        }
        if (!productId) {
          // 建档新商品
          const r = await api('product:create', {
            sku_code: '', barcode: '', category: it.category || '其他', brand: it.brand || '', model: it.model || '',
            cost_price: cost, suggest_price: 0, status: '待盘点', unit: it.unit || '件',
          })
          productId = r.id
        }
        const payload = { productId, quantity: qty, costPrice: cost, location: '', operator: getOperator() }
        if (expiry) payload.expiryDate = expiry
        await api('inbound:create', payload)
        okCount++
      } catch (e) { failCount++; failNames.push(name + '(' + (e.message || '') + ')') }
    }
    showStamp('入库完成', '成功 ' + okCount + ' 项' + (failCount > 0 ? ' · 失败 ' + failCount : ''), failCount === 0)
    if (failCount > 0) toast('失败: ' + failNames.join('、'))
    loadRecents()
    render()
  }

  // 拍照 → 压缩到 1280px JPEG（减小 base64，AI 识别更快更稳）→ 调 ai:photoDraft
  async function compressPhoto(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const img = new Image()
        img.onload = () => {
          const max = 1280
          let w = img.width, h = img.height
          if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r) }
          const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
          canvas.getContext('2d').drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', 0.7).split(',')[1])
        }
        img.onerror = () => reject(new Error('图片读取失败'))
        img.src = String(reader.result)
      }
      reader.onerror = () => reject(new Error('图片读取失败'))
      reader.readAsDataURL(file)
    })
  }

  /** 把照片挂到建档表单上（大图预览）—— 拍照是为了"确认商品 + 留图"，所以必须先看得见图 */
  function setPhotoPreview(b64) {
    const prev = document.getElementById('f-photo-prev')
    if (prev && b64) { prev.src = 'data:image/jpeg;base64,' + b64; prev.style.display = '' }
    const b = document.getElementById('f-photo-btn')
    if (b) b.innerHTML = FiIcon('check', 15) + ' 已拍好（点一下可重拍）'
  }

  /** 认出多行（整张进货单）时给个可选入口：点了才走批量核对，不强制 */
  function showBatchEntry(items) {
    const form = document.getElementById('inbound-form')
    const okBtn = document.getElementById('f-ok')
    if (!form || !okBtn || document.getElementById('f-batch')) return
    const b = document.createElement('button')
    b.id = 'f-batch'; b.type = 'button'
    b.style.cssText = 'width:100%;height:46px;margin-top:8px;border-radius:10px;border:2px solid var(--ink);background:var(--gold);color:#fff;font-size:15px;font-weight:800'
    b.innerHTML = FiIcon('clipboard', 15) + ' 这是进货单（' + items.length + ' 行）→ 逐行核对入库'
    b.onclick = function () { showBatchReview(items) }
    okBtn.parentNode.insertBefore(b, okBtn)
  }

  // 拍照 → **先把照片显示出来并开出建档表单**（不依赖网络），再让 AI 帮你预填名称/进价/售价/分类。
  // 用户拍这张照就是为了确认商品、并给商品留张图；所以任何情况下图都不能丢。
  async function photoFlow() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment'
    input.onchange = async function () {
      if (!input.files || !input.files[0]) return
      const file = input.files[0]
      let base64 = ''
      try { base64 = await compressPhoto(file) } catch (e) { toast('图片读取失败，重拍一张'); return }
      // ① 建档表单 + 照片预览（离线也能走到这一步）
      showCreateForm('', null)
      pendingPhoto = base64          // 注意：要放在 showCreateForm 之后（它会重置 pendingPhoto）
      setPhotoPreview(base64)
      // ② AI 只做"帮你先填"
      toast('AI 正在识别…')
      try {
        const r = await api('ai:photoDraft', { imageBase64: base64, mimeType: 'image/jpeg' })
        const items = (r && r.ok && Array.isArray(r.items)) ? r.items : []
        if (items.length > 0) {
          const it = items[0]
          const setV = (id, v) => { const el = document.getElementById(id); if (el && v != null && v !== '') el.value = v }
          setV('f-name', (((it.brand || '') + ' ' + (it.model || '')).trim()) || it.name || '')
          if (it.category) setV('f-cat', it.category)
          setV('f-cost', it.cost_price_yuan)
          setV('f-price', it.selling_price_yuan)
          if (it.quantity) setV('f-qty', it.quantity)
          const tag = document.getElementById('ai-tag'); if (tag) tag.classList.add('show')
          toast(items.length > 1 ? ('AI 认出 ' + items.length + ' 行，已填好第一行；整张进货单请点下面的按钮') : 'AI 已帮你填好，核对后点完成入库')
          if (items.length > 1) showBatchEntry(items)
        } else {
          toast('AI 没认出商品，手填就好（照片已挂上）')
        }
      } catch (e) { toast('AI 连不上，手填就好（照片已挂上）') }
    }
    input.click()
  }

  // 进货单核对页：列出 AI 识别的所有商品，可改数量/价格，点"全部入库"
  function showBatchReview(items) {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--paper);z-index:350;display:flex;flex-direction:column;color:var(--ink)'
    overlay.innerHTML =
      '<div style="padding:14px 16px;border-bottom:3px solid var(--ink);display:flex;align-items:center;gap:8px">' +
        '<button id="br-back" style="width:40px;height:40px;border-radius:8px;border:2px solid var(--ink);background:var(--card);font-size:18px">' + FiIcon('close', 16) + '</button>' +
        '<div style="flex:1"><div class="font-bold" style="font-size:16px">进货单核对</div><div class="text-xs" style="color:var(--sub)">AI 认出 ' + items.length + ' 行，核对数量/价格后一起入库</div></div>' +
      '</div>'
    const list = document.createElement('div'); list.style.cssText = 'flex:1;overflow-y:auto;padding:12px 16px'
    items.forEach((it, idx) => {
      const name = (it.brand || '') + ' ' + (it.model || '') || '未命名'
      const isNew = !it.product_id
      const card = document.createElement('div'); card.className = 'card'; card.style.margin = '0 0 10px'
      card.innerHTML =
        '<div class="split" style="margin-bottom:6px">' +
          '<div style="min-width:0"><div class="font-bold" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + name + '</div>' +
          '<div class="text-xs text-muted">' + (it.category || '其他') + (isNew ? ' · ' + FiIcon('sparkle', 12) + ' 新商品' : ' · 已有商品') + '</div></div>' +
          '<div class="text-right" style="flex:none"><span class="badge ' + (isNew ? 'badge-green' : 'badge') + '">' + (isNew ? '建档' : '入库') + '</span></div>' +
        '</div>' +
        '<div class="flex" style="gap:8px">' +
          '<div style="flex:1"><label class="text-xs text-muted">数量</label><input data-qty="' + idx + '" value="' + (it.quantity || 1) + '" inputmode="numeric" style="width:100%;height:40px;border:2px solid var(--ink);border-radius:8px;padding:0 8px;font-size:16px"></div>' +
          '<div style="flex:1"><label class="text-xs text-muted">进价(元)</label><input data-cost="' + idx + '" value="' + (it.cost_price_fen ? (it.cost_price_fen/100).toFixed(2) : '') + '" inputmode="decimal" style="width:100%;height:40px;border:2px solid var(--ink);border-radius:8px;padding:0 8px;font-size:16px"></div>' +
        '</div>'
      list.appendChild(card)
    })
    overlay.appendChild(list)
    const foot = document.createElement('div'); foot.style.cssText = 'padding:12px 16px calc(12px + env(safe-area-inset-bottom));border-top:3px solid var(--ink)'
    foot.innerHTML = '<button id="br-go" style="width:100%;height:56px;border:none;border-radius:12px;background:var(--green);color:#fff;font-size:18px;font-weight:900">全部入库（' + items.length + ' 项）</button>'
    overlay.appendChild(foot)
    document.body.appendChild(overlay)

    overlay.querySelector('#br-back').onclick = () => overlay.remove()
    overlay.querySelector('#br-go').onclick = async () => {
      // 收集用户改过的数量/价格
      const finalItems = items.map((it, idx) => {
        const q = document.querySelector('[data-qty="' + idx + '"]')?.value
        const c = document.querySelector('[data-cost="' + idx + '"]')?.value
        return {
          ...it,
          quantity: q ? parseFloat(q) : it.quantity,
          cost_price_yuan: c ? parseFloat(c) : (it.cost_price_fen ? it.cost_price_fen / 100 : 0),
        }
      })
      overlay.remove()
      await batchInbound(finalItems)
    }
  }

  async function finishInbound() {
    const form = document.getElementById('inbound-form')
    const name = document.getElementById('f-name').value.trim()
    const cat = document.getElementById('f-cat').value
    const costStr = document.getElementById('f-cost').value
    const unitEl = document.getElementById('f-unit')
    const unit = unitEl ? unitEl.value : '件'
    const qtyStr = document.getElementById('f-qty').value
    // 能不能填小数由**单位**决定（服务端 units.allow_decimal），不再写死「只有米能填小数」——
    // 蚯蚓按千克卖、饵料按包卖，老板要的就是这些单位能各自按自己的规矩填。
    const allowDec = fiUnitAllowsDecimal(unitEl)
    const qty = fiRoundQty(qtyStr, allowDec)
    if (!name) { toast('填个商品名就能入库了'); return }
    if (!(qty > 0)) { toast('填个数量'); return }
    const cost = costStr ? Math.round(parseFloat(costStr) * 100) : 0
    // 售价（可选）：填了以后手机开单点一下就卖，不用每次输价；留空就还是开单时现场填
    const priceStr = (document.getElementById('f-price') || {}).value || ''
    const price = priceStr ? Math.round(parseFloat(priceStr) * 100) : 0
    if (priceStr && !(price > 0)) { toast('售价填个大于 0 的数（元）'); return }
    const code = form.getAttribute('data-code') || ''
    // 保质期商品（饵料/小药/活饵/路亚假饵）必须填到期日，与电脑端 requiresExpiry 同口径
    if (EXPIRY_REQUIRED_CATEGORIES.includes(cat)) {
      const expiryEl = document.getElementById('f-expiry')
      if (!expiryEl || !expiryEl.value) {
        toast('保质期商品（饵料/小药/活饵/路亚假饵）必须填到期日')
        expiryEl && expiryEl.focus()
        return
      }
    }
    const expiryEl = document.getElementById('f-expiry')
    const expiry = expiryEl && expiryEl.value ? expiryEl.value : undefined
    try {
      const r = await api('product:create', {
        sku_code: code, barcode: code, category: cat, brand: '', model: name,
        cost_price: cost, suggest_price: price || 0, status: '待盘点', unit: unit,
      })
      await api('inbound:create', { productId: r.id, quantity: qty, costPrice: cost, location: '', operator: getOperator(), expiryDate: expiry })
      // 商品照片：建档拿到 id 后再挂（photo:save 只落盘，photo_path 要单独更新一次）。
      // 图没存上不算入库失败 —— 货已经进来了，只提示一句，别让人以为白干。
      if (pendingPhoto) {
        try { await FiPhoto.saveProductPhoto(r.id, pendingPhoto) }
        catch (e) { toast('已入库，但照片没存上：' + (e.message || '')) }
        pendingPhoto = null
      }
      showStamp('已入库', name + ' × ' + qty + unit, true)
      form.classList.remove('show')
      document.getElementById('ai-tag').classList.remove('show')
      ;['f-name', 'f-cost', 'f-qty', 'f-price'].forEach(id => { const el = document.getElementById(id); if (el) el.value = '' })
      const prevAfter = document.getElementById('f-photo-prev')
      if (prevAfter) { prevAfter.removeAttribute('src'); prevAfter.style.display = 'none' }
      const btnAfter = document.getElementById('f-photo-btn')
      if (btnAfter) btnAfter.innerHTML = FiIcon('camera', 15) + ' 拍一张 / 从相册选'
      loadRecents()
    } catch (e) { toast('入库失败: ' + e.message) }
  }

  render()
  loadLowStock()
})
