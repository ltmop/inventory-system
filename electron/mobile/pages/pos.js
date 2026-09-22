// pos.js: 开单页 —— 找货（分类 / 一个字搜索 / 真扫码 / 热销台面）→ 固定购物清单（可改价/加减/删）→ 四键结账
//
// 这一版（1.2.9）按店里实际用法重排：
//   · 购物清单**钉在页面下半截**，不再随页面滚走 —— 加一件看得见一件；
//   · 找货三条路：点分类行（完全不用打字）、搜一个字就出关联商品、扫码（原生实时识别）；
//   · 每件商品能拍照留图：拍完存在账本机器上，手机和电脑看的是同一张图；
//   · 开单页能直接改这一单的售价（不动商品档案里的定价），改错了能一键还原原价。
page('pos', function (app) {
  const cart = []
  let hotProducts = []
  let allProducts = []      // 全量商品（分类找货 + 单字联想用）
  let hotBasis = 'sales'
  let activeCat = ''        // '' = 热销台面；'__all' = 全部；其余 = 分类名
  let keyword = ''
  let serverHits = []       // 服务端搜索补出来的（本地全量里没有的）
  let busy = false
  let searchTimer = null
  let collapsed = false     // 购物清单收起状态（收起后只剩一行标题 + 收款键）

  let elMid = null, elCart = null, elCats = null, elInput = null

  // ---------- 顾客（老客户识别）与挂单 ----------
  // 老板 2026-09-21 两个问题：
  //   「人多时来不及录单怎么办？」→ 挂单：这一单先挂起，立刻开下一单，回头一键取回来结。
  //   「老客户的单怎么在开单时确认这个人是老客户？」→ 整单都带着顾客：选完立刻看到
  //     买过几次 / 累计多少 / 欠多少 / 上次什么时候来，并且这一单记在他名下。
  let customer = null            // 当前这一单的顾客（null = 散客）
  let tierCache = {}             // productId -> { tier: 价格分 }（客户价格档用）
  const HOLDS_KEY = 'fi-pos-holds'

  // ---------- 小工具 ----------
  function inCartQty(id) { let s = 0; cart.forEach(c => { if (c.product_id === id) s += c.qty }); return s }
  function cartTotal() { return cart.reduce((s, c) => s + c.selling_price * c.qty, 0) }
  function esc(s) { return escHtml(s) }
  function phHtml(p, cls) {
    return '<div class="' + (cls || 'ph') + '" style="background:' + phColor(p) + '">' + esc(phChar(p)) + '</div>'
  }
  // 商品图（有就显示图，没有就显示彩色首字）；version 用 updated_at 穿透缓存
  function imgHtml(p, cls) {
    const path = p.photo_path || p.photoPath
    if (!path || !window.FiPhoto) return ''
    return '<img class="' + (cls || 'im') + '" src="' + FiPhoto.productPhotoUrl(path, p.updated_at) + '" alt="" onerror="this.style.display=\'none\'">'
  }
  function thumbHtml(p, cls) {
    const img = imgHtml(p, cls)
    return img || phHtml(p, cls === 'im' ? 'ph' : cls)
  }
  function hl(text, kw) {
    const t = String(text == null ? '' : text)
    if (!kw) return esc(t)
    const i = t.toLowerCase().indexOf(String(kw).toLowerCase())
    if (i < 0) return esc(t)
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + kw.length)) + '</mark>' + esc(t.slice(i + kw.length))
  }

  // ---------- 载入 ----------
  loadData()

  // 断网/换码时的兜底：用本机缓存里最近一次的商品铺台面（收银台最不能空屏）
  function fromCache(n) {
    try {
      const all = allProducts.length ? allProducts : (apiCached('product:list', { keyword: '', limit: 500 }) || [])
      const inStock = all.filter((p) => (p.total_stock || 0) > 0)
      return (inStock.length ? inStock : all).slice(0, n)
    } catch (e) { return [] }
  }

  async function loadData() {
    // ① 先用缓存铺台面（冷启动/离线秒出）
    const cAll = apiCached('product:list', { keyword: '', limit: 500 })
    if (Array.isArray(cAll) && cAll.length) { allProducts = cAll; renderCats() }
    const cHot = apiCached('report:posQuickPicks', { days: 30, limit: 12 })
    if (cHot && cHot.items && cHot.items.length) { hotProducts = cHot.items; hotBasis = cHot.basis || 'sales'; renderMid(true) }
    else if (allProducts.length) { hotProducts = fromCache(12); hotBasis = 'cache'; renderMid(true) }

    // ② 再拉真数据
    try {
      const hot = await api('report:posQuickPicks', { days: 30, limit: 12 })
      if (hot && hot.items && hot.items.length) { hotProducts = hot.items; hotBasis = hot.basis || 'sales' }
    } catch (e) { /* 保底还有缓存 */ }
    try {
      const all = await api('product:list', { keyword: '', limit: 500 })
      if (Array.isArray(all) && all.length) { allProducts = all; renderCats(); enrichHot() }
    } catch (e) { /* 同上 */ }
    if (!hotProducts.length) { const c = fromCache(12); if (c.length) { hotProducts = c; hotBasis = 'cache' } }
    enrichHot()
    hotProducts = dedupeByName(hotProducts)
    renderMid(true)
  }

  // 同名商品只留一件（老板反馈常卖货出现重复）：
  // 库里确实有 4 条同名档案"倍利 伊势尼钩 有刺"，台面上连着排四张一模一样的卡。
  // 这里按「品牌+型号」归一化去重，优先留有货的、货多的在前；真正的重复档案要合并（另做数据清理）。
  function dedupeByName(list) {
    const seen = {}
    return (list || []).filter(function (p) {
      const key = String(((p.brand || '') + ' ' + (p.model || '')).trim() || p.sku_code || p.id).replace(/\s+/g, ' ').toLowerCase()
      if (seen[key]) return false
      seen[key] = 1
      return true
    })
  }

  // 热销接口只回 销量用的字段；库存/图片/条码从全量列表里补上（离线也算得出来）
  function enrichHot() {
    if (!allProducts.length || !hotProducts.length) return
    const m = {}
    allProducts.forEach(function (p) { m[p.id] = p })
    hotProducts.forEach(function (h) {
      const p = m[h.id]
      if (!p) return
      if (h.total_stock == null) h.total_stock = p.total_stock || 0
      if (!h.photo_path) { h.photo_path = p.photo_path; h.updated_at = p.updated_at }
      if (!h.unit) h.unit = p.unit
      if (!h.category) h.category = p.category
      if (!h.barcode) h.barcode = p.barcode
    })
  }

  // ---------- 骨架：三区固定 ----------
  app.innerHTML = ''
  app.classList.add('absorb')      // 这一页只让中间滚，购物车与收款钉在下面
  const root = document.createElement('div'); root.className = 'pos'
  const top = document.createElement('div'); top.className = 'pos-top'
  elMid = document.createElement('div'); elMid.className = 'pos-mid'
  elCart = document.createElement('div'); elCart.className = 'pos-cart'

  // 顶部：扫码 + 搜索
  const row = document.createElement('div'); row.className = 'scanrow'
  const scanbtn = document.createElement('button'); scanbtn.className = 'scanbtn'
  scanbtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="19" height="19"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M4 12h16"/></svg>扫码'
  scanbtn.onclick = () => openScanner(handleScan, '扫条码或手输商品')
  elInput = document.createElement('input')
  elInput.className = 'search'; elInput.type = 'search'; elInput.placeholder = '搜品名/型号/条码，一个字也行'
  elInput.value = keyword
  elInput.oninput = function () {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(function () {
      keyword = (elInput.value || '').trim()
      serverHits = []
      renderMid(true)
      if (keyword) fetchServerHits(keyword)
    }, 160)
  }
  row.appendChild(scanbtn); row.appendChild(elInput)
  top.appendChild(row)

  // 分类行：不想打字就点这里（第二行横滑）
  elCats = document.createElement('div'); elCats.className = 'cats'
  top.appendChild(elCats)

  // 「今天该做的事」钉在开单页顶部 —— 老板打开 APP 第一眼就该看到（2026-09-21 主动触达）
  const todoBar = document.createElement('div'); todoBar.id = 'todo-bar'
  top.appendChild(todoBar)
  fiRenderTodoBar(todoBar)

  // 操作员（老板 / 店员）：原来单独占一整行，白扔 60px；现在挂到「热销 / 货架」标题右边。
  // 老板反馈"空白页太多、中间的商品页被挤没了" —— 这一行就是主要来源之一。
  function operatorChip() {
    const b = document.createElement('button')
    b.className = 'acct-chip'
    b.style.cssText = 'margin-left:auto;font-size:calc(var(--s)*11px);padding:3px 10px 3px 4px'
    b.innerHTML = '<span class="av">' + FiIcon('user', 12) + '</span><span class="nm">' + esc(getOperator()) + '</span>'
    b.title = '点这里换人（算谁的账）'
    b.onclick = function (e) {
      e.stopPropagation()
      openOperatorPanel()
      setTimeout(function () { renderMid(false) }, 1400)
    }
    return b
  }

  root.appendChild(top); root.appendChild(elMid); root.appendChild(elCart)
  app.appendChild(root)
  renderCats(); renderMid(true); renderCart()

  // 购物清单加多了会占掉下半屏，把商品货架压住 —— 老板反馈"加多了容易把商品页盖住"。
  // 处理：① CSS 把清单最多压到 .pos 的 34%；② 只要往下翻商品，就把清单自动收成一行，
  // 商品页立刻全露出来；点一下清单条又展开（收起的行数、金额、结账键都还在）。
  let lastMidTop = 0
  elMid.addEventListener('scroll', function () {
    const top = elMid.scrollTop
    const dy = top - lastMidTop
    lastMidTop = top
    if (dy > 12 && cart.length && !collapsed) { collapsed = true; renderCart() }
  }, { passive: true })

  // ---------- 分类行 ----------
  function catList() {
    const m = {}
    allProducts.forEach(function (p) { const c = (p.category || '其他'); m[c] = (m[c] || 0) + 1 })
    return Object.keys(m).map(function (k) { return { name: k, count: m[k] } }).sort(function (a, b) { return b.count - a.count })
  }
  function renderCats() {
    if (!elCats) return
    elCats.innerHTML = ''
    function chip(label, val, count, iconName) {
      const b = document.createElement('button')
      b.className = 'cat' + (activeCat === val && !keyword ? ' on' : '')
      b.innerHTML = (iconName ? FiIcon(iconName, 13) : '') + esc(label) + (count != null ? ' <span class="n">' + count + '</span>' : '')
      b.onclick = function () {
        activeCat = (activeCat === val ? '' : val)
        keyword = ''; if (elInput) elInput.value = ''
        renderCats(); renderMid(true)
      }
      elCats.appendChild(b)
    }
    chip('热销', '', null, 'bolt')
    chip('全部', '__all', allProducts.length || null)
    catList().forEach(function (c) { chip(c.name, c.name, c.count) })
  }

  // ---------- 中间：货架 ----------
  function renderMid(resetScroll) {
    if (!elMid) return
    const st = elMid.scrollTop
    elMid.innerHTML = ''
    if (keyword) buildSearch(elMid)
    else if (activeCat) buildCatShelf(elMid, activeCat)
    else buildHot(elMid)
    elMid.scrollTop = resetScroll ? 0 : st
  }

  function sectionTitle(box, tag, sub) {
    const t = document.createElement('div'); t.className = 'sectitle'
    t.innerHTML = '<span class="tag">' + esc(tag) + '</span><span>' + esc(sub) + '</span>'
    t.appendChild(operatorChip())
    box.appendChild(t)
  }

  function buildHot(box) {
    if (!hotProducts.length) {
      box.innerHTML = '<div class="empty" style="padding:26px 16px">台面还没货：点上面分类找，或扫码 / 搜一个字</div>'
      return
    }
    sectionTitle(box, hotBasis === 'sales' ? '本店热销' : (hotBasis === 'cache' ? '上次同步的货' : (hotBasis === 'mixed' ? '热销 + 常用货' : '常用货')),
      hotBasis === 'sales' ? '近30天卖得最多 · 点一下加单' : '卖一单后自动变热销榜')
    grid(box, hotProducts)
  }

  function buildCatShelf(box, cat) {
    const raw = cat === '__all' ? allProducts : allProducts.filter(function (p) { return (p.category || '其他') === cat })
    // 同名只留一个（有货的优先），否则分类里也会出现连排四张一样的卡
    const list = dedupeByName([...raw].sort(function (a, b) { return (b.total_stock || 0) - (a.total_stock || 0) }))
    if (!list.length) {
      box.innerHTML = '<div class="empty" style="padding:26px 16px">这个分类下没找到商品' + (allProducts.length ? '' : '（商品还没同步下来，连上网再来）') + '</div>'
      return
    }
    sectionTitle(box, cat === '__all' ? '全部商品' : cat, list.length + ' 种 · 点一下加单')
    grid(box, list.slice(0, 120))
    if (list.length > 120) {
      const more = document.createElement('div'); more.className = 'hint'; more.style.textAlign = 'center'
      more.textContent = '这一屏显示前 120 种，' + (list.length - 120) + ' 种请用搜索找'
      box.appendChild(more)
    }
  }

  function grid(box, list) {
    const g = document.createElement('div'); g.className = 'pgrid'
    list.forEach(function (p, i) { const card = productCard(p); card.style.setProperty('--i', i); g.appendChild(card) })
    box.appendChild(g)
  }

  function productCard(p) {
    const n = inCartQty(p.id)
    const card = document.createElement('div'); card.className = 'pcard'
    card.innerHTML = (n > 0 ? '<div class="badge">' + n + '</div>' : '') +
      // 图片区单独一层：相机按钮放图片里（原来钉在卡片左下角，把价格压住了）
      '<div class="thumb">' + thumbHtml(p, 'im') + '<div class="cam" title="给这件商品拍照">' + FiIcon('camera', 14) + '</div></div>' +
      '<div class="nm">' + esc(prodName(p)) + '</div>' +
      (function () {
        const fam = fiSpecFamily(p, allProducts)
        // 多规格的商品：卡片上说清「几个规格 · 共多少」，老板就知道点进去还要选规格
        if (fam.length > 1) return '<div class="pr"><span>' + fmt(p.suggest_price || 0) + '</span><span class="stk">' + fam.length + ' 规格 · 共 ' + fiSpecTotalStock(fam) + '</span></div>'
        return '<div class="pr"><span>' + fmt(p.suggest_price || 0) + '</span>' + (p.total_stock == null ? '' : '<span class="stk">存 ' + p.total_stock + '</span>') + '</div>'
      })()
    card.onclick = function () { addToCart(p) }
    const cam = card.querySelector('.cam')
    cam.onclick = function (e) { e.stopPropagation(); snapPhoto(p) }
    return card
  }

  // 搜索结果（本机全量先出，服务端结果再补）
  function buildSearch(box) {
    const local = localMatch(keyword)
    const seen = {}
    local.forEach(function (p) { seen[p.id] = 1 })
    const rows = local.concat(serverHits.filter(function (p) { return !seen[p.id] }))
    if (!rows.length) {
      box.innerHTML = '<div style="padding:10px 16px">' +
        '<div class="text-sm text-muted" style="margin-bottom:8px">没找到「' + esc(keyword) + '」，可以现场建档卖：</div>' +
        '<button class="scanbtn" id="create-sell" style="width:100%;height:48px;background:var(--blue);color:#fff">' + FiIcon('plus', 16) + ' 建档卖「' + esc(keyword) + '」</button>' +
        '</div>'
      const btn = document.getElementById('create-sell')
      if (btn) btn.onclick = async function () { const p = await createOnTheFly(keyword); if (p) addToCart(p) }
      return
    }
    sectionTitle(box, '找到 ' + rows.length + ' 个', '点一下加单')
    rows.forEach(function (p) {
      // 角标也统一在蓝白体系里：热销=实心蓝，处理=浅蓝描边
      const badges = (p.is_hot === 1 ? '<span class="badge" style="display:inline-flex;align-items:center;gap:3px;background:var(--blue);color:#fff">' + FiIcon('bolt', 11) + '热销</span> ' : '') +
        (p.is_clearance === 1 ? '<span class="badge badge-blue" style="display:inline-flex;align-items:center;gap:3px">' + FiIcon('tag', 11) + '处理</span> ' : '')
      const r = document.createElement('div'); r.className = 'srow'
      r.innerHTML = thumbHtml(p, 'im') +
        '<div class="info">' +
          '<div class="n">' + badges + hl(prodName(p), keyword) + '</div>' +
          '<div class="d">' + esc(p.category || '') + ' · 存 ' + (p.total_stock || 0) + ' · ' + esc(p.sku_code || '') + '</div>' +
        '</div>' +
        '<div class="pr">' + fmt(p.suggest_price || 0) + '</div>' +
        '<div class="cam2">' + FiIcon('camera', 15) + '</div>'
      r.onclick = function (e) { if (e.target.closest('.cam2')) { snapPhoto(p); return } addToCart(p) }
      r.style.setProperty('--i', rows.indexOf(p))
      box.appendChild(r)
    })
  }

  function localMatch(kw) {
    const k = String(kw).toLowerCase()
    const out = []
    allProducts.forEach(function (p) {
      const name = prodName(p).toLowerCase()
      const sku = String(p.sku_code || '').toLowerCase()
      const bc = String(p.barcode || '').toLowerCase()
      const cat = String(p.category || '').toLowerCase()
      let score = -1
      if (bc && bc === k) score = 0
      else if (sku && sku === k) score = 0
      else if (name.indexOf(k) === 0) score = 1
      else if (sku.indexOf(k) === 0) score = 2
      else if (name.indexOf(k) > 0) score = 3
      else if (cat.indexOf(k) >= 0) score = 4
      else if (sku.indexOf(k) > 0 || bc.indexOf(k) >= 0) score = 5
      if (score >= 0) out.push({ p: p, s: score })
    })
    out.sort(function (a, b) { return (a.s - b.s) || ((b.p.total_stock || 0) - (a.p.total_stock || 0)) })
    return out.slice(0, 60).map(function (x) { return x.p })
  }

  async function fetchServerHits(kw) {
    try {
      const rows = await api('product:search', { keyword: kw })
      if (keyword !== kw) return
      const have = {}
      allProducts.forEach(function (p) { have[p.id] = 1 })
      serverHits = (rows || []).filter(function (p) { return !have[p.id] })
      if (serverHits.length) renderMid(true)
    } catch (e) { /* 本地结果已经在了 */ }
  }

  // ---------- 底部：购物清单（固定） ----------
  // ---------- 顾客：老客户识别 ----------
  // 「老客户」判据：有过成交（last_deal_at 有值）或确实买过东西（spent > 0）。
  // 不能只看欠款 —— 天天来但每次付清的才是最好的老主顾，欠款是 0。
  function isOldCustomer(c) { return !!(c && (c.last_deal_at || (c.spent || 0) > 0)) }
  function custLabel() { return customer ? (customer.name + (isOldCustomer(customer) ? ' · 老客户' : ' · 新客户')) : '散客' }
  function priceLevelName(lv) {
    return ({ retail: '零售价', regular: '常客价', VIP: 'VIP 价', wholesale: '批发价', promo: '促销价' })[lv] || lv
  }
  function daysAgo(ts) {
    if (!ts) return ''
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ''
    const n = Math.floor((Date.now() - d.getTime()) / 86400000)
    if (n <= 0) return '今天来过'
    if (n === 1) return '昨天来过'
    if (n < 30) return n + ' 天前来过'
    return Math.floor(n / 30) + ' 个月前来的'
  }
  // 按客户的价格档取价（price_tiers）；没设这档价返回 null → 退回建议零售价
  async function tierPriceFor(p) {
    const lv = customer && customer.price_level
    if (!lv || !p || p.id == null) return null
    try {
      if (!tierCache[p.id]) {
        const rows = await api('priceTier:list', { productId: p.id })
        const m = {}
        ;(rows || []).forEach(function (r) { m[r.tier] = r.price })
        tierCache[p.id] = m
      }
      const price = tierCache[p.id][lv]
      return price > 0 ? price : null
    } catch (e) { return null }
  }
  async function pickCustomer() {
    let list = []
    try { list = (await api('customer:list')) || [] } catch (e) { toast('加载客户失败：' + e.message); return }
    openCustomerPanel(list)
  }
  // 选中顾客：如果他带价格档，把清单里没手动改过价的行按档重算
  async function applyCustomer(c) {
    customer = c
    if (!c) { toast('已设为散客'); renderCart(); return }
    toast(isOldCustomer(c)
      ? ('老客户 ' + c.name + '：买过 ' + (c.orders || 0) + ' 次 · 累计 ' + fmt(c.spent || 0) + (c.outstanding > 0 ? ' · 欠 ' + fmt(c.outstanding) : ''))
      : ('新客户 ' + c.name + '（第一次来）'))
    if (c.price_level && cart.length) {
      for (const line of cart) {
        if (line.price_changed) continue
        const tp = await tierPriceFor(line.product)
        if (tp) { line.selling_price = tp; line.orig_price = tp }
      }
    }
    renderCart()
  }

  // 顾客面板：搜姓名 / 手机号 / 会员号；老客户置顶（按最近成交），一行说清他是谁。
  // onPick 可选 —— 赊账流程要拿到"选中的是谁"再继续，就传它；不传则直接设为当前顾客。
  function openCustomerPanel(list, onPick) {
    const ov = document.createElement('div')
    ov.id = 'cust-panel'
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.96);z-index:320;display:flex;flex-direction:column;padding:18px;color:#e6edf5'
    ov.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
        '<div style="font-size:19px;font-weight:800;flex:1">这单卖给谁？</div>' +
        '<button id="cust-close" style="width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:19px">' + FiIcon('close', 16) + '</button>' +
      '</div>' +
      '<input id="cust-q" placeholder="打名字 / 手机号 / 会员号，或直接挑" style="height:50px;border-radius:12px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:#fff;font-size:17px;padding:0 14px;margin-bottom:10px;outline:none">' +
      '<div id="cust-list" style="flex:1;overflow:auto"></div>' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button id="cust-none" style="flex:1;height:50px;border-radius:12px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#c7d2e0;font-size:15px;font-weight:700">不选（散客）</button>' +
        '<button id="cust-new" style="flex:1;height:50px;border-radius:12px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:15px;font-weight:800">' + FiIcon('plus', 14) + ' 新建客户</button>' +
      '</div>'
    document.body.appendChild(ov)
    const box = ov.querySelector('#cust-list')
    const q = ov.querySelector('#cust-q')

    function cardHtml(c) {
      const bits = ['买过 ' + (c.orders || 0) + ' 次']
      if (c.spent > 0) bits.push('累计 ' + fmt(c.spent))
      if (c.outstanding > 0) bits.push('欠 ' + fmt(c.outstanding))
      const ago = daysAgo(c.last_deal_at)
      if (ago) bits.push(ago)
      if (c.phone) bits.push(c.phone)
      const tag = isOldCustomer(c)
        ? '<span style="background:#22c55e;color:#fff;border-radius:999px;padding:1px 9px;font-size:11.5px;font-weight:800">老客户</span>'
        : '<span style="background:rgba(255,255,255,.16);color:#c7d2e0;border-radius:999px;padding:1px 9px;font-size:11.5px;font-weight:800">第一次来</span>'
      const lv = (c.price_level && c.price_level !== 'retail')
        ? '<span style="margin-left:auto;color:#d4af37;font-size:12px;font-weight:700">' + esc(priceLevelName(c.price_level)) + '</span>' : ''
      return '<div data-cust="' + c.id + '" style="padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.08);margin-bottom:8px">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:17px;font-weight:800">' + esc(c.name) + '</span>' + tag + lv +
        '</div>' +
        '<div style="font-size:12.5px;color:#8fa3c0;margin-top:4px">' + esc(bits.join(' · ')) + '</div>' +
      '</div>'
    }
    function paint() {
      const kw = String(q.value || '').trim().toLowerCase()
      let rows = list.slice()
      // 老客户、最近成交的排前面 —— 忙的时候不用翻
      rows.sort(function (a, b) {
        const ao = isOldCustomer(a) ? 0 : 1, bo = isOldCustomer(b) ? 0 : 1
        if (ao !== bo) return ao - bo
        return String(b.last_deal_at || '').localeCompare(String(a.last_deal_at || ''))
      })
      if (kw) {
        rows = rows.filter(function (c) {
          return String(c.name || '').toLowerCase().indexOf(kw) >= 0 ||
            String(c.phone || '').indexOf(kw) >= 0 ||
            String(c.member_no || '').toLowerCase().indexOf(kw) >= 0
        })
      }
      // 一个客户都没建过 / 没搜到时，把「怎么办」直接写在界面上 —— 老板现在库里是 0 个客户，
      // 不告诉他这一步，功能再全也认不出老客户。
      box.innerHTML = rows.length ? rows.map(cardHtml).join('')
        : (list.length === 0
          ? '<div style="padding:14px;color:#8fa3c0;line-height:1.85">还没建过客户。<br>第一次来的顾客，点下面「新建客户」记个名字 + 手机号；<br>以后结账时打手机号<b style="color:#d4af37">后 4 位</b>就能认出来，谁买过多少、欠多少一目了然。</div>'
          : '<div style="padding:14px;color:#8fa3c0;line-height:1.85">没找到「' + esc(q.value) + '」。<br>手机号打后 4 位就能匹配；确实没建过，点下面「新建客户」。<br><span style="font-size:12px">（建过一次以后，他一进门你就知道是老客户了）</span></div>')
      box.querySelectorAll('[data-cust]').forEach(function (el) {
        el.onclick = function () {
          const c = rows.find(function (x) { return x.id === Number(el.getAttribute('data-cust')) })
          if (!c) return
          ov.remove()
          if (onPick) onPick(c)
          else applyCustomer(c)
        }
      })
    }
    q.oninput = paint
    paint()
    ov.querySelector('#cust-close').onclick = function () { ov.remove() }
    ov.querySelector('#cust-none').onclick = function () { ov.remove(); if (onPick) onPick(null); else applyCustomer(null) }
    ov.querySelector('#cust-new').onclick = async function () {
      const name = prompt('新客户名字？')
      if (!name) return
      const phone = prompt('手机号？（可不填；填了下次打后四位就出来）', '') || ''
      try {
        const r = await api('customer:create', { name: name, phone: phone, notes: '' })
        ov.remove()
        const c = { id: r.id, name: name, phone: phone }
        if (onPick) onPick(c)
        else applyCustomer(c)
      } catch (e) { toast('建客户失败：' + e.message) }
    }
  }

  // ---------- 挂单（人多时来不及录单）----------
  // 零售店的常规解法：一个顾客还没拿定 / 还没付款，先把这一单"挂着"，
  // 立刻开下一单，回头点一下取回来接着结。挂单只存在这台手机上，断网也在。
  function readHolds() { try { const v = JSON.parse(localStorage.getItem(HOLDS_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch (e) { return [] } }
  function writeHolds(list) { try { localStorage.setItem(HOLDS_KEY, JSON.stringify(list.slice(0, 20))) } catch (e) { /* 存不下不影响当前这单 */ } }
  function holdTotal(h) { return (h.cart || []).reduce(function (s, c) { return s + c.selling_price * c.qty }, 0) }
  function holdQty(h) { return (h.cart || []).reduce(function (s, c) { return s + c.qty }, 0) }
  function holdCurrent() {
    if (!cart.length) { toast('清单是空的，不用挂'); return }
    const list = readHolds()
    list.unshift({
      id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      at: Date.now(),
      customer: customer ? { id: customer.id, name: customer.name, price_level: customer.price_level, spent: customer.spent, orders: customer.orders } : null,
      cart: cart.map(function (c) { return { product_id: c.product_id, product: c.product, qty: c.qty, selling_price: c.selling_price, orig_price: c.orig_price, price_changed: c.price_changed } }),
    })
    writeHolds(list)
    cart.length = 0
    customer = null
    resetIdem()
    fiTrack('pos:hold', true, 0)
    toast('已挂起 ' + list[0].cart.length + ' 种商品，可以开下一单了（点「取单」能取回来）')
    renderCart(); renderMid()
  }
  function openHoldsSheet() {
    const list = readHolds()
    const ov = sheet('挂着的单（' + list.length + '）',
      (list.length ? list.map(function (h) {
        const t = new Date(h.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        return '<div style="display:flex;align-items:center;gap:9px;padding:12px 0;border-bottom:1px solid var(--line2)">' +
          '<div style="flex:1;min-width:0">' +
            '<div class="font-bold" style="font-size:15px">' + holdQty(h) + ' 件 · ' + fmt(holdTotal(h)) + (h.customer ? ' · ' + esc(h.customer.name) : '') + '</div>' +
            '<div class="text-xs text-muted" style="margin-top:2px">' + t + ' 挂起 · ' + (h.cart || []).length + ' 种商品</div>' +
          '</div>' +
          '<button data-resume="' + h.id + '" style="height:40px;padding:0 15px;border-radius:10px;border:none;background:var(--blue);color:#fff;font-size:14.5px;font-weight:800">取回来</button>' +
          '<button data-drop="' + h.id + '" style="height:40px;width:42px;border-radius:10px;border:1px solid var(--red);background:#fff;color:var(--red);font-size:14px;font-weight:800">删</button>' +
        '</div>'
      }).join('') : '<div class="text-sm text-muted" style="padding:14px 0">没有挂着的单。</div>') +
      '<div class="text-xs text-muted" style="margin-top:12px;line-height:1.75">忙的时候：把这一单先挂起（不结账、不丢货），立刻开下一单；回头点「取回来」接着结。<br>挂单只存在这台手机上，断网也能用。</div>')
    ov.querySelectorAll('[data-resume]').forEach(function (b) {
      b.onclick = function () {
        const h = readHolds().find(function (x) { return x.id === b.getAttribute('data-resume') })
        if (!h) return
        if (cart.length && !confirm('清单里现在还有 ' + cart.length + ' 种商品，取回来会先清掉它。继续？')) return
        cart.length = 0
        ;(h.cart || []).forEach(function (c) { cart.push(c) })
        customer = h.customer || null
        writeHolds(readHolds().filter(function (x) { return x.id !== h.id }))
        resetIdem()
        ov.remove()
        collapsed = false
        renderCart(); renderMid()
        fiTrack('pos:resume', true, 0)
        toast('取回来了：' + (h.cart || []).length + ' 种商品')
      }
    })
    ov.querySelectorAll('[data-drop]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('删掉这单挂着的东西？（只是不记了，商品档案和库存都不受影响）')) return
        writeHolds(readHolds().filter(function (x) { return x.id !== b.getAttribute('data-drop') }))
        ov.remove()
        renderCart()
        toast('已删')
      }
    })
  }
  // 购物清单上那条「顾客 / 挂起 / 取单」条：开单全程都能看到这单卖给谁
  function custBar() {
    const holds = readHolds().length
    const bar = document.createElement('div')
    bar.className = 'cfbar'
    bar.innerHTML =
      '<button class="cfcust' + (customer ? (isOldCustomer(customer) ? ' old' : ' on') : '') + '">' + FiIcon('users', 13) + ' ' + esc(custLabel()) + '</button>' +
      '<button class="cfhold">' + FiIcon('download', 13) + ' 挂起</button>' +
      (holds ? '<button class="cfholds">' + FiIcon('undo', 13) + ' 取单 ' + holds + '</button>' : '')
    bar.querySelector('.cfcust').onclick = function (e) { e.stopPropagation(); pickCustomer() }
    bar.querySelector('.cfhold').onclick = function (e) { e.stopPropagation(); holdCurrent() }
    const hb = bar.querySelector('.cfholds')
    if (hb) hb.onclick = function (e) { e.stopPropagation(); openHoldsSheet() }
    return bar
  }

  function renderCart() {
    if (!elCart) return
    const totalFen = cartTotal()
    const n = cart.reduce(function (s, c) { return s + c.qty }, 0)

    // 空清单：只占一行（原来空着也占半屏，实测 610px、其中 254px 纯空白，
    // 把商品货架挤到只剩一行半 —— 老板说"中间的商品页被挤没了"）。
    elCart.className = 'pos-cart' + (cart.length ? '' : ' is-empty') + (collapsed ? ' collapsed' : '')
    elCart.innerHTML = ''
    if (!cart.length) {
      const bar = document.createElement('div'); bar.className = 'chead'
      // 空清单**不额外占一行**（原来空着也占半屏，老板说"商品页被挤没了"）：
      // 把「认顾客 / 取单」直接塞进这一行 —— 比那句没人看的提示文字有用得多。
      const holds0 = readHolds().length
      bar.innerHTML = '<span class="t">' + FiIcon('cart', 16) + '购物清单</span>' +
        '<button class="cfcust' + (customer ? (isOldCustomer(customer) ? ' old' : ' on') : '') + '">' + FiIcon('users', 13) + ' ' + esc(custLabel()) + '</button>' +
        (holds0 ? '<button class="cfholds">' + FiIcon('undo', 13) + ' 取单 ' + holds0 + '</button>' : '') +
        '<span class="sum">' + fmt(0) + '</span>' +
        // 「结账」两个字一直在（老板说看不到结账按钮），加货后变成整条大按钮
        '<button class="paybtn mini" disabled>' + FiIcon('check', 15) + '结账</button>'
      elCart.appendChild(bar)
      bar.querySelector('.cfcust').onclick = function (e) { e.stopPropagation(); pickCustomer() }
      const hb0 = bar.querySelector('.cfholds')
      if (hb0) hb0.onclick = function (e) { e.stopPropagation(); openHoldsSheet() }
      return
    }

    const head = document.createElement('div'); head.className = 'chead'
    head.innerHTML = '<span class="t">' + FiIcon('cart', 16) + '购物清单' + (cart.length ? '<span class="pill">' + n + '</span>' : '') + '</span>' +
      (cart.length ? '<button class="clr">' + FiIcon('trash', 12) + '清空</button>' : '') +
      '<span class="sum">' + fmt(totalFen) + '</span>' +
      '<span class="chev">' + FiIcon('chevron', 14) + '</span>'
    head.onclick = function (e) {
      if (e.target.closest('.clr')) {
        e.stopPropagation()
        if (confirm('清空购物清单？（商品档案不受影响）')) { cart.length = 0; resetIdem(); renderCart(); renderMid() }
        return
      }
      collapsed = !collapsed; renderCart()
    }
    elCart.appendChild(head)
    elCart.appendChild(custBar())

    const list = document.createElement('div'); list.className = 'clist'
    if (!cart.length) {
      list.innerHTML = '<div class="empty">点上面分类 / 货架里的商品加单；一个字也能搜，扫码也行</div>'
    } else {
      cart.forEach(function (c) { list.appendChild(cartLine(c)) })
    }
    elCart.appendChild(list)

    const tail = document.createElement('div'); tail.className = 'ctail'
    tail.innerHTML = '<div class="total"><span class="t">合计' + (cart.length ? '（点结账选收款方式）' : '') + '</span><span class="v">' + fmt(totalFen) + '</span></div>' +
      // 一个明确的「结账」按钮（老板说看不到结账按钮 —— 原来只有四个收款键，没有"结账"两个字）
      '<button class="paybtn" id="pos-pay"' + ((busy || !cart.length) ? ' disabled' : '') + '>' +
        FiIcon('check', 18) + (cart.length ? '结账' : '结账（先加商品）') + '</button>' +
      ''
    const payBtn = tail.querySelector('#pos-pay')
    if (payBtn) payBtn.onclick = function () { if (cart.length && !busy) openPaySheet() }
    elCart.appendChild(tail)
  }

  function cartLine(c) {
    const p = c.product
    const isMeter = p.unit === '米' || p.unit === '斤' || p.unit === '公斤'
    const step = isMeter ? 0.5 : 1
    const changed = c.price_changed === true
    const line = document.createElement('div'); line.className = 'line'
    line.innerHTML = thumbHtml(p, 'im') +
      '<div class="info">' +
        '<div class="n">' + esc(prodName(p)) + '</div>' +
        '<div class="p">' +
          '<span class="pb" title="点这里改这一单的卖价">' + fmt(c.selling_price) + (isMeter ? '/' + esc(p.unit) : '') + FiIcon('edit', 11) + '</span>' +
          (changed ? '<span class="chg">已改价</span><span class="rs" title="还原原价">' + FiIcon('undo', 11) + '原 ' + fmt(c.orig_price) + '</span>' : (c.price_persist ? '<span class="chg" style="background:var(--blue-l);color:var(--blue)">长期价</span>' : '')) +
        '</div>' +
      '</div>' +
      '<div class="qty"><button data-m>' + FiIcon('minus', 14) + '</button><span class="n" data-e>' + c.qty + (isMeter ? esc(p.unit) : '') + '</span><button data-p>' + FiIcon('plus', 14) + '</button></div>' +
      '<button class="del" data-del title="从购物清单移除这一行">' + FiIcon('close', 14) + '</button>'
    line.querySelector('[data-m]').onclick = function () {
      c.qty = Math.round((c.qty - step) * 10) / 10
      if (c.qty <= 0) cart.splice(cart.indexOf(c), 1)
      resetIdem(); renderCart(); renderMid()
    }
    line.querySelector('[data-p]').onclick = function () {
      c.qty = Math.round((c.qty + step) * 10) / 10
      resetIdem(); renderCart(); renderMid()
    }
    line.querySelector('[data-e]').onclick = function () { editQty(c) }
    line.querySelector('[data-del]').onclick = function () { cart.splice(cart.indexOf(c), 1); resetIdem(); renderCart(); renderMid() }
    line.querySelector('.pb').onclick = function () { editPrice(c) }
    const rs = line.querySelector('.rs')
    if (rs) rs.onclick = function () { c.selling_price = c.orig_price; c.price_changed = false; renderCart() }
    const th = line.querySelector('.im, .ph')
    if (th) th.onclick = function () { if (p.photo_path || p.photoPath) previewPhoto(p); else snapPhoto(p) }
    return line
  }

  // 点价格 → 改这一单的卖价；改完问一句：只改这一单，还是以后这件货都按这个价（改商品档案）
  function editPrice(c) {
    const name = prodName(c.product)
    const cur = (c.selling_price / 100).toFixed(2).replace(/\.00$/, '')
    const v = prompt('「' + name + '」这一单卖多少钱？（元）\n（填完会问你：只改这一单，还是以后都按这个价）', cur)
    if (v === null) return
    const n = parseFloat(v)
    if (!(n > 0)) { toast('价格要大于 0'); return }
    const fen = Math.round(n * 100)
    c.selling_price = fen
    c.price_changed = fen !== c.orig_price
    resetIdem()
    renderCart()
    askPriceScope(c, fen)
  }

  // 改价范围：一次性 / 长期改档案。老板原话："要提醒是否固定当前商品价格，而不是一次性的。"
  function askPriceScope(c, fen) {
    const p = c.product
    const ov = sheet('这个价怎么用？',
      '<div class="text-sm text-muted" style="margin-bottom:12px">「' + esc(prodName(p)) + '」改成 <b style="color:var(--blue)">' + fmt(fen) + '</b>。<br>只改这一单，还是以后都按这个价卖？</div>' +
      '<button id="ps-once" class="okbtn">只改这一单（一次性）</button>' +
      '<button id="ps-keep" style="width:100%;height:48px;margin-top:10px;border-radius:12px;border:1px solid var(--line);background:var(--card2);font-size:15px;font-weight:800;color:var(--ink)">以后这件货都按 ' + fmt(fen) + ' 卖（改商品档案）</button>' +
      '<div class="text-xs text-muted" style="margin-top:10px;line-height:1.7">一次性：只影响当前这一单，商品档案里的定价不动，行尾点 ↺ 可还原。<br>长期：改商品档案售价，以后开单默认带这个价，库存页和电脑端也跟着变。</div>')
    ov.querySelector('#ps-once').onclick = function () { ov.remove(); toast('这一单按 ' + fmt(fen) + ' 结算') }
    ov.querySelector('#ps-keep').onclick = async function () {
      ov.remove()
      try {
        await api('product:update', { id: p.id, suggest_price: fen, operator: getOperator() })
        const at = new Date().toISOString()
        // 本地同步：热销榜、分类货架、清单里的这件（没手动改过价的）都跟着改
        ;[allProducts, hotProducts].forEach(function (list) {
          (list || []).forEach(function (x) { if (x.id === p.id) { x.suggest_price = fen; x.updated_at = at } })
        })
        cart.forEach(function (x) {
          if (x.product_id === p.id && !x.price_persist) {
            x.selling_price = fen; x.orig_price = fen; x.price_changed = false
            x.product.suggest_price = fen
          }
        })
        c.price_persist = true
        toast('已改商品档案：以后「' + prodName(p) + '」都按 ' + fmt(fen) + ' 卖')
        renderCart(); renderMid()
      } catch (e) { toast('改档案失败：' + ((e && e.message) || '请重试')) }
    }
  }

  // 点数量 → 精确填数（米/斤这类可以填小数）
  function editQty(c) {
    const isMeter = c.product.unit === '米' || c.product.unit === '斤' || c.product.unit === '公斤'
    const v = prompt('「' + prodName(c.product) + '」卖多少' + (isMeter ? esc(c.product.unit) + '？' : '个？'), String(c.qty))
    if (v === null) return
    const n = parseFloat(v)
    if (isMeter) {
      const rounded = Math.round(n * 10) / 10
      if (!(n > 0) || Math.abs(rounded - n) > 1e-9) { toast('数量要大于 0，最多 1 位小数'); return }
      c.qty = rounded
    } else {
      if (!Number.isInteger(n) || n <= 0) { toast('件数要是 ≥1 的整数'); return }
      c.qty = n
    }
    resetIdem(); renderCart(); renderMid()
  }

  // ---------- 拍照留图（存到账本那台机器，手机/电脑同一张图） ----------
  async function snapPhoto(p) {
    if (!window.FiPhoto) { toast('这一版没有拍照模块，更新后再试'); return }
    try {
      const b64 = await FiPhoto.pickPhoto()
      if (!b64) return
      toast('正在保存图片…')
      const path2 = await FiPhoto.saveProductPhoto(p.id, b64)
      const at = new Date().toISOString()
      p.photo_path = path2; p.updated_at = at
      allProducts.forEach(function (x) { if (x.id === p.id) { x.photo_path = path2; x.updated_at = at } })
      hotProducts.forEach(function (x) { if (x.id === p.id) { x.photo_path = path2; x.updated_at = at } })
      cart.forEach(function (c) { if (c.product_id === p.id) { c.product.photo_path = path2; c.product.updated_at = at } })
      renderMid(); renderCart()
      toast('已给「' + prodName(p) + '」加图，电脑上也能看到')
    } catch (e) { toast('加图失败：' + ((e && e.message) || '请重试')) }
  }

  function previewPhoto(p) {
    const url = FiPhoto.productPhotoUrl(p.photo_path, p.updated_at)
    const ov = document.createElement('div')
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.94);z-index:340;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px'
    ov.innerHTML = '<img src="' + url + '" style="max-width:100%;max-height:74vh;border-radius:12px;background:#fff">' +
      '<div style="color:#e6edf5;font-size:15px;font-weight:700;margin-top:12px">' + esc(prodName(p)) + '</div>' +
      '<button style="margin-top:14px;height:46px;padding:0 22px;border-radius:12px;border:none;background:rgba(255,255,255,.14);color:#fff;font-size:16px">关闭</button>'
    ov.onclick = function () { ov.remove() }
    document.body.appendChild(ov)
  }

  // 选规格：一个大按钮一个规格，直接看到「规格名 · 库存 · 价格」，点一下就加单。
  // 老板的问题「开单时还要选哪种规格嘛？如何高效又方便」——答案就是把它摊成按钮，一次点完，
  // 不用去记 SKU、也不用在搜索框里打「3.9m」。
  function openSpecPicker(p, fam) {
    const base = fiSpecProductName(p)
    const ov = sheet(base + ' · 选规格',
      '<div class="text-sm text-muted" style="margin-bottom:10px">这个商品有 ' + fam.length + ' 个规格，点一个加进清单：</div>' +
      fam.map(function (x) {
        const st = Number(x.total_stock) || 0
        const nm = fiSpecName(x) || (x.sku_code || '（没写规格）')
        return '<button data-spec="' + x.id + '" style="width:100%;display:flex;align-items:center;gap:10px;padding:13px 14px;margin-bottom:8px;border-radius:12px;border:1px solid var(--line);background:var(--card2);text-align:left">' +
          '<span style="flex:1;min-width:0">' +
            '<span style="display:block;font-size:16.5px;font-weight:800;color:var(--ink)">' + esc(nm) + '</span>' +
            '<span style="display:block;font-size:12.5px;color:var(--sub);margin-top:2px">' + esc(x.sku_code || '') + '</span>' +
          '</span>' +
          '<span style="flex:none;text-align:right">' +
            '<span style="display:block;font-size:15px;font-weight:800;color:' + (st > 0 ? 'var(--green)' : 'var(--danger)') + '">' + (st > 0 ? ('存 ' + st) : '没货') + '</span>' +
            '<span style="display:block;font-size:12.5px;color:var(--sub)">' + (x.suggest_price ? fmt(x.suggest_price) : '未定价') + '</span>' +
          '</span>' +
        '</button>'
      }).join('') +
      '<div class="text-xs text-muted" style="margin-top:6px;line-height:1.8">规格名就是商品档案里的「子分类」（例：3.9m-1.5#）。<br>要改规格名：库存页 → 详情 / 改价 · 换图。</div>')
    ov.querySelectorAll('[data-spec]').forEach(function (b) {
      b.onclick = function () {
        const x = fam.find(function (y) { return y.id === Number(b.getAttribute('data-spec')) })
        ov.remove()
        if (x) { fiTrack('pos:specpick', true, 0); addToCart(x, { skipSpec: true }) }
      }
    })
  }

  // ---------- 加单 ----------
  function seeCart(msg) {
    collapsed = false
    renderCart()
    if (msg) toast('已加入购物清单：' + msg)
  }

  async function addToCart(p, opts) {
    // 同一个商品有多个规格（线号/长度/号数…）时，先让他选规格 ——
    // 老板点名的就是这件事：「开单时还要选哪种规格嘛？如何高效又方便」
    if (!(opts && opts.skipSpec)) {
      const fam = fiSpecFamily(p, allProducts)
      if (fam.length > 1) { openSpecPicker(p, fam); return }
    }
    // 分类台面上的商品常只有 p.* 字段，用总数补齐一下
    if (p.total_stock === undefined) p.total_stock = 0
    const existing = cart.find(function (c) { return c.product_id === p.id })
    const isMeter = p.unit === '米' || p.unit === '斤' || p.unit === '公斤'
    if (existing) {
      existing.qty = isMeter ? Math.round((existing.qty + 0.5) * 10) / 10 : existing.qty + 1
      resetIdem(); seeCart(prodName(p) + ' ×' + existing.qty); renderMid(); return
    }
    let price = p.suggest_price
    // 选了顾客就按他的价格档带价（电脑上给他设了常客价/VIP价/批发价就按那个走；
    // 商品没设过这一档的，仍然走建议零售价）
    const tiered = await tierPriceFor(p)
    if (tiered) price = tiered
    // 没设售价的货必须现场填售价，不按进价兜底卖（不然倒贴钱）
    if (!price) {
      const s = prompt('「' + prodName(p) + '」没设售价，卖多少钱？（元）\n（填完也可以在这一单里继续改价）', '')
      if (!s || !(parseFloat(s) > 0)) { toast('得填个售价才能卖'); return }
      price = Math.round(parseFloat(s) * 100)
    }
    let qty = 1
    if (isMeter) {
      const s = prompt('「' + prodName(p) + '」卖多少' + p.unit + '？', '1')
      const n = s ? parseFloat(s) : NaN
      if (!(n > 0)) { toast('得填个数量'); return }
      qty = Math.round(n * 10) / 10
    }
    cart.push({ product_id: p.id, product: p, qty: qty, selling_price: price, orig_price: price, price_changed: false })
    resetIdem()
    seeCart(prodName(p) + ' ×' + qty)
    renderMid()
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

  async function createOnTheFly(code) {
    const name = prompt('这个商品叫什么名字？（选填）', code)
    if (!name) return null
    const costStr = prompt('进价多少元？（毛利就靠它算，别乱填）', '')
    if (!costStr || !(parseFloat(costStr) > 0)) { toast('得填个真实进价，毛利才算得准'); return null }
    const cost = Math.round(parseFloat(costStr) * 100)
    const priceStr = prompt('卖多少钱？（元）例如 85', '')
    const price = priceStr ? Math.round(parseFloat(priceStr) * 100) : 0
    const isMeter = confirm('这个商品按斤/米等称重卖吗？（确定=按"斤"可开小数，取消=按个/件整数卖）')
    const category = (activeCat && activeCat !== '__all') ? activeCat : (prompt('归到哪个分类？（饵料/鱼线/鱼钩…）', '其他') || '其他')
    const unit = isMeter ? '斤' : '件'
    try {
      const r = await api('product:create', {
        sku_code: code, barcode: code, category: category, brand: '', model: name,
        cost_price: cost, suggest_price: price, unit: unit,
      })
      const qty = parseFloat(prompt(isMeter ? '大概多少斤？不准没关系，以后盘点会校正' : '大概多少个？不准没关系，以后盘点会校正', '1')) || 1
      await api('inbound:create', { productId: r.id, quantity: qty, costPrice: cost, location: '', operator: getOperator() })
      return { id: r.id, sku_code: code, barcode: code, brand: '', model: name, category: category, suggest_price: price, cost_price: cost, unit: unit, total_stock: qty }
    } catch (e) { toast('新建失败: ' + e.message); return null }
  }

  // ---------- 结账 ----------
  function blockMsg(r) {
    if (!r) return '未通过'
    if (r.error) return r.error
    if (r.shortages && r.shortages.length) return '库存不足：' + r.shortages.map(function (s) { return (s.name || ('#' + s.productId)) + ' 缺 ' + s.shortage }).join('，')
    if (r.expired) return '单里含已过期批次，请处理后再开单'
    return '未通过'
  }

  let checkoutIdKey = null
  function idemFor() { if (!checkoutIdKey) checkoutIdKey = String(Date.now()) + '-' + Math.random().toString(36).slice(2); return checkoutIdKey }
  function resetIdem() { checkoutIdKey = null }

  function payItems() {
    return cart.map(function (c) { return { productId: c.product_id, quantity: c.qty, sellingPrice: c.selling_price } })
  }

  async function checkout(method) {
    if (cart.length === 0 || busy) return
    busy = true; renderCart()
    const custName = customer ? customer.name : ''
    const t0 = Date.now()
    try {
      // 选了顾客就把这一单记在他名下（付清的**不传** paidAmount → 不产生欠款）。
      // 这样「这客户买过几次、累计多少」才算得出来，开单时也才看得出谁是老客户。
      const r = await api('outbound:checkout', {
        items: payItems(), payMethod: method, operator: getOperator(), idempotencyKey: idemFor(),
        customerId: customer ? customer.id : undefined,
      })
      if (r && r.ok === false) { fiTrack('pos:checkout', false, Date.now() - t0); toast('开单被拦截：' + blockMsg(r)); return }
      const totalFen = cartTotal()
      // 结账动画：先把清单「飞走」，再盖章 —— 老板要看得见的反馈
      try {
        const rows = document.querySelectorAll('.pos-cart .line')
        rows.forEach(function (el, i) { el.style.animation = 'payFly .42s cubic-bezier(.22,1,.36,1) both'; el.style.animationDelay = (i * 55) + 'ms' })
        await new Promise(function (r) { setTimeout(r, 260) })
      } catch (e) { /* 动画失败不影响记账 */ }
      showStamp('收讫', fmt(totalFen) + ' · ' + method + (custName ? ' · ' + custName : ''), false)
      cart.length = 0
      customer = null
      resetIdem()
      fiTrack('pos:checkout', true, Date.now() - t0)
    } catch (e) { fiTrack('pos:checkout', false, Date.now() - t0); toast('结账失败: ' + e.message) } finally { busy = false; renderCart(); renderMid() }
  }

  // 赊账：必须先落到一个客户头上。这一单还没选顾客就先选（选完继续赊）
  async function creditCheckout() {
    if (cart.length === 0 || busy) return
    if (customer) { await doCredit(customer); return }
    let list = []
    try { list = (await api('customer:list')) || [] } catch (e) { toast('加载客户失败：' + e.message); return }
    openCustomerPanel(list, async function (c) {
      if (!c) { toast('赊账得选一个客户'); return }
      await applyCustomer(c)
      await doCredit(c)
    })
  }
  async function doCredit(cust) {
    busy = true; renderCart()
    const totalFen = cartTotal()
    const t0 = Date.now()
    try {
      const r = await api('outbound:checkout', {
        items: payItems(), operator: getOperator(),
        customerId: cust.id, paidAmount: 0, idempotencyKey: idemFor(),
      })
      if (r && r.ok === false) { toast('赊账被拦截：' + blockMsg(r)); return }
      showStamp('已赊', fmt(totalFen) + ' · ' + cust.name, false)
      cart.length = 0
      customer = null
      resetIdem()
      fiTrack('pos:credit', true, Date.now() - t0)
    } catch (e) { fiTrack('pos:credit', false, Date.now() - t0); toast('赊账失败：' + e.message) }
    finally { busy = false; renderCart(); renderMid() }
  }

  // 结账：点「结账」大按钮 → 选收款方式（现金 / 微信 / 支付宝 / 赊账）
  function openPaySheet() {
    const totalFen = cartTotal()
    const qtyAll = cart.reduce(function (s, c) { return s + c.qty }, 0)
    const ov = sheet('结账 ' + fmt(totalFen),
      '<div class="text-sm text-muted" style="margin-bottom:12px">这单 ' + cart.length + ' 种商品 · 共 ' + qtyAll + ' 件，选一个收款方式：</div>' +
      // 顾客那一行：老客户在这里一眼可见（买过几次、是不是第一次来），也能当场换人/认人
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:10px 12px;border-radius:12px;background:var(--card2);border:1px solid var(--line)">' +
        '<span style="color:var(--blue);display:flex">' + FiIcon('users', 15) + '</span>' +
        '<span class="text-sm" style="flex:1;min-width:0">' +
          (customer
            ? ('顾客：<b>' + esc(customer.name) + '</b>' + (isOldCustomer(customer) ? '（老客户 · 买过 ' + (customer.orders || 0) + ' 次' + (customer.outstanding > 0 ? ' · 欠 ' + fmt(customer.outstanding) : '') + '）' : '（第一次来）'))
            : '顾客：散客（点右边认人，记他名下才好统计）') +
        '</span>' +
        '<button id="pay-pick-cust" style="height:34px;padding:0 12px;border-radius:9px;border:1px solid var(--line);background:#fff;color:var(--blue);font-size:13.5px;font-weight:800">' + (customer ? '换人' : '选顾客') + '</button>' +
      '</div>' +
      '<div class="payrow4">' +
        '<button data-pay="现金" style="background:linear-gradient(135deg,#3b82f6,#2563eb)">' + FiIcon('wallet', 18) + '现金</button>' +
        '<button data-pay="微信" style="background:linear-gradient(135deg,#22c55e,#0f9d68)">' + FiIcon('phone', 18) + '微信</button>' +
        '<button data-pay="支付宝" style="background:linear-gradient(135deg,#60a5fa,#1d4ed8)">' + FiIcon('bolt', 18) + '支付宝</button>' +
        '<button data-pay="赊账" style="background:linear-gradient(135deg,#64748b,#334155)">' + FiIcon('users', 18) + '赊账</button>' +
      '</div>' +
      '<div class="text-xs text-muted" style="margin-top:12px;line-height:1.7">现金：直接记「收讫」<br>微信 / 支付宝：先给顾客看你的收款码，到账再记账<br>赊账：选客户，记在 TA 头上</div>')
    const pickCust = ov.querySelector('#pay-pick-cust')
    if (pickCust) pickCust.onclick = async function () {
      ov.remove()
      let list = []
      try { list = (await api('customer:list')) || [] } catch (e) { toast('加载客户失败：' + e.message); openPaySheet(); return }
      // 选完（包括选「散客」）都回到结账面板，不用重新点一遍
      openCustomerPanel(list, async function (c) { await applyCustomer(c); openPaySheet() })
    }
    ov.querySelectorAll('[data-pay]').forEach(function (b) {
      b.onclick = function () {
        const m = b.getAttribute('data-pay')
        ov.remove()
        if (m === '现金') checkout('现金')
        else if (m === '赊账') creditCheckout()
        else payWithQr(m)
      }
    })
  }

  // 微信/支付宝：先全屏展示收款码让顾客扫，到账后点「已完成收款」再记账（对账有依据）
  async function payWithQr(method) {
    if (cart.length === 0 || busy) return
    const type = method === '微信' ? 'wx' : 'ali'
    let qrImg = null
    try { const q = await api('payment:getQr'); qrImg = q ? q[type] : null } catch (e) { qrImg = null }
    const totalFen = cartTotal()
    if (!qrImg) {
      if (confirm('电脑上还没配' + method + '收款码，顾客没法扫这个码。\n\n点「确定」用现金收款，点「取消」取消这单。')) checkout('现金')
      return
    }
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:350;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;color:var(--ink)'
    overlay.innerHTML =
      '<div style="font-size:21px;font-weight:900;margin-bottom:6px">请顾客扫' + method + '收款码</div>' +
      '<div style="font-size:16px;color:var(--sub);margin-bottom:12px">应收 <b style="color:var(--ink)">' + fmt(totalFen) + '</b></div>' +
      '<div style="width:min(88vw,340px);background:#fff;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,.12);padding:10px">' +
        '<img src="' + qrImg + '" style="width:100%;height:auto;display:block;border-radius:8px">' +
      '</div>' +
      '<div style="margin-top:10px;font-size:13px;color:var(--sub)">请把屏幕调亮，让顾客扫</div>' +
      '<button id="qr-done" style="margin-top:16px;width:100%;max-width:340px;height:56px;border:none;border-radius:14px;background:var(--green);color:#fff;font-size:19px;font-weight:900">已完成收款</button>' +
      '<button id="qr-cancel" style="margin-top:10px;height:44px;border:none;background:transparent;color:var(--sub);font-size:15px">还没收到，取消</button>'
    document.body.appendChild(overlay)
    overlay.querySelector('#qr-cancel').onclick = function () { overlay.remove() }
    overlay.querySelector('#qr-done').onclick = function () { overlay.remove(); checkout(method) }
  }


  // 从库存页点商品跳过来：自动把该商品加进购物清单
  try {
    const preselectId = localStorage.getItem('fi-pos-preselect')
    if (preselectId) {
      localStorage.removeItem('fi-pos-preselect')
      api('product:search', { keyword: String(preselectId) }).then(function (rows) {
        if (rows && rows.length > 0) addToCart(rows[0])
      }).catch(function () {})
    }
  } catch (e) { /* localStorage 不可用忽略 */ }
})
