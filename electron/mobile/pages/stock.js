// stock.js: 库存查询 —— 打开直接显示全部 SKU，按分类/货位分组，大字卡片（40岁+友好）
// 2026-09-20：加「分类筛选」（不再一个个翻）+ 「删除 / 改停产」（服务端只允许删无批次无流水的商品）
page('stock', function (app) {
  let keyword = ''
  let cat = ''            // 选中的分类（'' = 全部）
  let brandView = ''      // 选中的品牌（'' = 还在品牌列表这一层）
  // 从入库页「看全部」跳过来时，直接开好"只看低库存"（老板点一下就该看到缺的货）
  let lowOnly = !!window.__fiStockLowOnly
  try { window.__fiStockLowOnly = false } catch (e) { /* 忽略 */ }
  let all = apiCached('product:list', { keyword: '', limit: 500 }) || [] // 首帧先用上次缓存
  let results = all
  let tmr = null

  async function search(kw) {
    keyword = kw
    clearTimeout(tmr)
    tmr = setTimeout(async () => {
      try { all = await api('product:list', { keyword: kw, limit: 500 }) || [] } catch { all = [] }
      if (cat && !all.some(p => (p.category || '其他') === cat)) cat = ''   // 分类被筛没了就回全部
      applyFilter()
    }, 250)
  }

  function brandOf(p) { return String(p.brand || '').trim() || '（没填品牌）' }

  function applyFilter() {
    results = all.filter(p => {
      if (cat && (p.category || '其他') !== cat) return false
      if (brandView && brandOf(p) !== brandView) return false
      if (lowOnly && !((p.total_stock || 0) < (p.min_stock || 5))) return false
      return true
    })
    render()
  }

  // 切换热销/处理货标记，成功后刷新列表
  async function toggleMark(id, field, value) {
    try {
      await api('product:mark', { id, [field]: value ? 1 : 0, operator: getOperator() })
      await search(keyword)
    } catch (e) { toast('标记失败: ' + (e.message || '')) }
  }

  // 删除商品：服务端只允许删「无批次、无流水」的；否则引导改成「停产」（保留历史，最安全）
  async function removeProduct(p) {
    const name = prodName(p)
    if (!confirm('删除「' + name + '」？\n\n只能删没有入库批次和流水的商品；有历史的会被拦下，可以改成「停产」。')) return
    try {
      const r = await api('product:delete', { id: p.id, operator: getOperator() })
      if (r && r.ok === false) {
        // 有历史：给出「改停产」的替代动作，而不是死路
        const why = r.reason || '该商品有库存或流水记录，不能删除'
        if (confirm(why + '\n\n改成「停产」？停产后不出现在开单热销榜，但历史账目完整保留。')) {
          try {
            await api('product:update', { id: p.id, status: '停产', operator: getOperator() })
            toast('已改为停产')
            await search(keyword)
          } catch (e2) { toast('改停产失败: ' + (e2.message || '')) }
        }
        return
      }
      toast('已删除「' + name + '」')
      await search(keyword)
    } catch (e) { toast('删除失败: ' + (e.message || '')) }
  }

  // 打开商品详情/编辑页（改价、改单位、改预警线、改货位、换图、去开单）。
  // 沿用开单页 fi-pos-preselect 的现成约定：把这一行商品 JSON 带过去，不新增后端通道。
  function openDetail(p) {
    try { localStorage.setItem('fi-product-edit', JSON.stringify(p)) } catch (e) { /* 存不下时详情页会兜底提示 */ }
    navigate('product')
  }

  // 商品图片：拍照/相册 → 存到账本机器 + 挂到商品。已有商品补图、换图都走这里。
  // 换图后文件名不变，靠列表重拉后 URL 带上新的 updated_at 穿透浏览器缓存。
  //
  // 老板 2026-09-22：「有图片了，但状态老是显示待盘点，已经有图片证明已经盘点过了」。
  // 拍照本来就等于"我亲手看过这件货了"，所以这里顺手问一句数量：
  //   填了数量 → 记一笔 inbound:create（批次 + 库存 + 状态「已盘点」一次到位）；
  //   留空或取消 → 只换图，不动库存也不动状态（只想换张图的人照样能用）。
  async function pickProductPhoto(p) {
    const name = prodName(p)
    const unit = p.unit || '件'
    try {
      const b64 = await FiPhoto.pickPhoto()
      if (!b64) return

      let qty = 0
      try {
        const allowDec = await unitAllowsDecimal(unit)
        const qtyStr = prompt('「' + name + '」你数了多少' + unit + '？\n（留空＝只换图，不改库存和状态）', '')
        const v = qtyStr === null ? 0 : (parseFloat(qtyStr) || 0)
        qty = allowDec ? Math.round(v * 100) / 100 : Math.round(v)
      } catch (e) { qty = 0 }

      toast('正在上传「' + name + '」的图片…')
      // 先把图存好再入库：入库万一失败，照片也不能丢（照片比数字更难补）
      await FiPhoto.saveProductPhoto(p.id, b64)

      if (qty > 0) {
        try {
          const payload = { productId: p.id, quantity: qty, costPrice: p.cost_price, location: p.location || '', operator: getOperator() }
          if (EXPIRY_REQUIRED_CATEGORIES.indexOf(p.category) >= 0) payload.expiryDate = defaultExpiryDate(p.category)
          await api('inbound:create', payload)
          toast('已入库 ' + qty + unit + '，状态已变「已盘点」')
        } catch (e) {
          toast('图片已存，但入库没成功：' + (e.message || '') + '（可再点一次📷补数）')
        }
      } else {
        toast('图片已保存')
      }
      await search(keyword)
    } catch (e) { toast('图片保存失败：' + (e.message || '')) }
  }

  // 改库存数量（老板 2026-09-21：「库存里无法改数量」）。
  // 走服务端 stock:adjust —— 它内部是给这个商品开一张一行的盘点单，
  // 所以差异 / 原因 / 经手人都留在盘点记录里，事后查得到；不是偷偷把数字改掉。
  let unitDecCache = null
  async function unitAllowsDecimal(u) {
    if (!unitDecCache) { try { unitDecCache = await api('unit:list') } catch (e) { unitDecCache = [] } }
    const row = (unitDecCache || []).find(function (x) { return x.name === u })
    return !!(row && row.allow_decimal)
  }

  async function openAdjustSheet(p) {
    const name = prodName(p)
    const cur = Number(p.total_stock || 0)
    const unit = p.unit || '件'
    const dec = await unitAllowsDecimal(unit)
    const step = dec ? 0.1 : 1
    const reasons = ['盘少了', '盘多了', '卖漏了', '记错了', '其他']
    const stepBtn = 'width:58px;height:58px;border-radius:14px;border:1px solid var(--line);background:var(--card2);font-size:28px;font-weight:800;line-height:1'
    const ov = sheet('改库存数量',
      '<div class="text-sm text-muted" style="margin-bottom:10px;line-height:1.75">' + escHtml(name) + '<br>账上现在是 <b style="color:var(--ink);font-size:17px">' + cur + ' ' + escHtml(unit) + '</b>，你数出来是多少？</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
        '<button data-step="-1" style="' + stepBtn + '">&minus;</button>' +
        '<input id="adj-qty" inputmode="decimal" value="' + cur + '" style="flex:1;min-width:0;height:58px;text-align:center;font-size:27px;font-weight:800;border:2px solid var(--blue);border-radius:14px;background:#fff;color:var(--ink)">' +
        '<button data-step="1" style="' + stepBtn + '">+</button>' +
      '</div>' +
      '<div class="text-xs text-muted" style="margin-bottom:6px">为什么对不上？（会记进盘点记录，方便以后回查）</div>' +
      '<div class="gap wrap" style="margin-bottom:14px">' +
        reasons.map(function (r, i) { return '<button data-reason="' + escHtml(r) + '" class="tag" style="height:36px;padding:0 13px;font-size:13.5px;font-weight:700;' + (i === 0 ? 'background:var(--blue);color:#fff;border-color:var(--blue)' : '') + '">' + escHtml(r) + '</button>' }).join('') +
      '</div>' +
      '<button id="adj-ok" style="width:100%;height:56px;border-radius:14px;border:none;background:var(--blue);color:#fff;font-size:18px;font-weight:800">确定改成这个数</button>' +
      '<div class="text-xs text-muted" style="margin-top:10px;line-height:1.75">改完会生成一张盘点单（电脑端「盘点管理」能回看）。不是直接把数字改掉 —— 库存是账，得留下差异记录。</div>')

    const input = ov.querySelector('#adj-qty')
    let reason = reasons[0]
    ov.querySelectorAll('[data-step]').forEach(function (b) {
      b.onclick = function () {
        const d = Number(b.getAttribute('data-step')) * step
        const v = Math.max(0, Math.round(((parseFloat(input.value) || 0) + d) * 10) / 10)
        input.value = String(v)
      }
    })
    ov.querySelectorAll('[data-reason]').forEach(function (b) {
      b.onclick = function () {
        reason = b.getAttribute('data-reason')
        ov.querySelectorAll('[data-reason]').forEach(function (x) {
          const on = x === b
          x.style.background = on ? 'var(--blue)' : ''
          x.style.color = on ? '#fff' : ''
          x.style.borderColor = on ? 'var(--blue)' : ''
        })
      }
    })
    const okBtn = ov.querySelector('#adj-ok')
    okBtn.onclick = async function () {
      const v = parseFloat(input.value)
      if (!isFinite(v) || v < 0) { toast('数量要填 0 或更大的数'); return }
      if (!dec && !Number.isInteger(v)) { toast('「' + unit + '」只能填整数'); return }
      if (v === cur) { toast('账上本来就是 ' + cur + '，没改动'); return }
      okBtn.disabled = true
      okBtn.textContent = '正在改…'
      const t0 = Date.now()
      try {
        const r = await api('stock:adjust', { productId: p.id, actualQty: v, reason: reason, operator: getOperator() })
        ov.remove()
        fiTrack('stock:adjust', true, Date.now() - t0)
        const diff = (r && r.diff) || 0
        toast('已改：' + cur + ' → ' + v + ' ' + unit + '（' + (diff > 0 ? '多了 ' + diff : '少了 ' + Math.abs(diff)) + '）')
        await search(keyword)
      } catch (e) {
        fiTrack('stock:adjust', false, Date.now() - t0)
        okBtn.disabled = false
        okBtn.textContent = '确定改成这个数'
        toast('改库存失败：' + ((e && e.message) || '请重试'))
      }
    }
  }

  function render() {
    app.innerHTML = ''
    // 固定顶栏：搜索/筛选/统计钉在最上面，往下翻也能随时搜（老板反馈"划下去就搜不了"）
    const sticky = document.createElement('div'); sticky.className = 'sticky-bar'
    app.appendChild(sticky)

    // 搜索框
    const sr = document.createElement('div'); sr.className = 'scanrow'
    const inp = document.createElement('input'); inp.className = 'search'; inp.placeholder = '输入品名 / 条码 / SKU'; inp.value = keyword
    inp.oninput = (e) => search(e.target.value.trim())
    sr.appendChild(inp); sticky.appendChild(sr)

    // 扫码查库存
    const btn = document.createElement('button'); btn.className = 'scanbtn'
    btn.style.cssText = 'flex:none;margin:0;padding:0 13px'
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M4 12h16"/></svg>扫码'
    btn.onclick = () => openScanner((code) => { if (code) { inp.value = code; search(code) } }, '扫码查库存')
    sr.appendChild(btn)

    // ---- 分类筛选条（横滑）：不用再一个个翻 ----
    const cats = {}
    all.forEach(p => { const c = p.category || '其他'; cats[c] = (cats[c] || 0) + 1 })
    const catNames = Object.keys(cats).sort((a, b) => cats[b] - cats[a])
    if (catNames.length > 1 || cat) {
      // 用统一的 .cats/.cat 样式（白蓝）—— 原来这里是内联黑底，和新设计撞色又看不清字
      const bar = document.createElement('div'); bar.className = 'cats'
      const mk = (label, on, fn) => {
        const b = document.createElement('button')
        b.className = 'cat' + (on ? ' on' : '')
        b.textContent = label
        b.onclick = fn
        return b
      }
      bar.appendChild(mk('全部 ' + all.length, cat === '' && !lowOnly, () => { cat = ''; applyFilter() }))
      bar.appendChild(mk('只看低库存', lowOnly, () => { lowOnly = !lowOnly; applyFilter() }))
      catNames.forEach(c => bar.appendChild(mk(c + ' ' + cats[c], cat === c, () => { cat = (cat === c ? '' : c); applyFilter() })))
      sticky.appendChild(bar)
    }

    // ===== 两级视图第一层：只列品牌（老板要的：先看品牌，点进去才看规格）=====
    if (!brandView) {
      const byBrand = {}
      results.forEach(p => { const b = brandOf(p); (byBrand[b] = byBrand[b] || []).push(p) })
      const names = Object.keys(byBrand).sort((a, b) => byBrand[b].length - byBrand[a].length)
      if (names.length === 0) {
        const empty0 = document.createElement('div'); empty0.className = 'empty'
        empty0.textContent = keyword ? ('没有找到「' + keyword + '」') : '加载中...'
        app.appendChild(empty0)
        return
      }
      names.forEach((b, bi) => {
        const list = byBrand[b]
        const stock = list.reduce((s, p) => s + (p.total_stock || 0), 0)
        const prices = list.map(p => p.suggest_price).filter(v => v > 0)
        const avg = prices.length ? Math.round(prices.reduce((s, v) => s + v, 0) / prices.length) : 0
        const lowN = list.filter(p => (p.total_stock || 0) < (p.min_stock || 5)).length
        const row = document.createElement('div')
        row.className = 'card tap'
        row.style.cssText = 'padding:12px 14px;cursor:pointer;animation:cardIn .34s var(--ease) both;animation-delay:' + (bi * 16) + 'ms'
        row.innerHTML =
          '<div class="flex" style="align-items:center;gap:11px">' +
            '<div style="width:38px;height:38px;border-radius:11px;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;flex:none">' + escHtml(b.slice(0, 1)) + '</div>' +
            '<div style="flex:1;min-width:0">' +
              '<div class="font-bold" style="font-size:15px">' + escHtml(b) + '</div>' +
              '<div class="text-xs text-muted" style="margin-top:2px">' + list.length + ' 种规格 · 库存 ' + stock +
                (avg ? ' · 均价 ' + fmt(avg) : '') + (lowN ? ' · <span class="text-red">' + lowN + ' 种缺货</span>' : '') + '</div>' +
            '</div>' +
            '<div style="color:#c3ccd8;display:flex">' + FiIcon('chevron', 16) + '</div>' +
          '</div>'
        row.onclick = function () { brandView = b; applyFilter() }   // 必须走 applyFilter，否则列表不会按品牌过滤
        app.appendChild(row)
      })
      return
    }

    if (results.length === 0) {
      const empty = document.createElement('div'); empty.className = 'text-center text-muted'; empty.style.padding = '30px'; empty.style.fontSize = '15px'
      empty.textContent = keyword ? '没有找到「' + keyword + '」' : (cat || lowOnly ? '这个筛选下没有商品' : '加载中...')
      app.appendChild(empty)
      return
    }

    // 进到品牌里：顶部给一个明显的返回
    const backRow = document.createElement('div')
    backRow.className = 'card tap'
    backRow.style.cssText = 'margin-top:10px;padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:9px'
    backRow.innerHTML = '<span style="display:flex;color:var(--blue)">' + FiIcon('undo', 16) + '</span>' +
      '<span class="font-bold" style="font-size:14px">' + escHtml(brandView) + '</span>' +
      '<span class="text-xs text-muted">全部规格</span>' +
      '<span class="text-xs" style="margin-left:auto;color:var(--blue)">← 返回品牌</span>'
    backRow.onclick = function () { brandView = ''; applyFilter() }
    app.appendChild(backRow)

    // 顶部统计（大字）
    const lowCount = results.filter(p => (p.total_stock || 0) < (p.min_stock || 5)).length
    const stat = document.createElement('div'); stat.style.cssText = 'padding:8px 18px 12px;font-size:15px;font-weight:700'
    stat.textContent = '共 ' + results.length + ' 个SKU' + (cat ? '（' + cat + '）' : '') + (lowCount > 0 ? ' · 低库存 ' + lowCount + ' 个' : ' · 库存都充足')
    stat.style.paddingBottom = '10px'
    sticky.appendChild(stat)

    // 低库存置顶
    const sorted = [...results].sort((a, b) => {
      const aLow = (a.total_stock || 0) < (a.min_stock || 5) ? 1 : 0
      const bLow = (b.total_stock || 0) < (b.min_stock || 5) ? 1 : 0
      if (aLow !== bLow) return bLow - aLow
      return (a.category || '').localeCompare(b.category || '')
    })

    // 按「商品（品牌+型号）」分组：同一个商品的多个规格聚成一组。
    // 老板 2026-09-21：「总数量是总数量，单一规格数量是单一规格的数量」——
    // 所以每组先给一个商品头（写总数量 + 几个规格），下面才是各规格各自的卡片与数量。
    const groups = {}
    sorted.forEach(p => {
      const key = fiSpecKey(p)
      ;(groups[key] = groups[key] || []).push(p)
    })

    // 分片上屏：先画首屏，剩下的按帧补，300 个 SKU 不再一次卡住主线程
    const q = []
    let qi = 0
    function drain() {
      const t0 = Date.now()
      while (qi < q.length && Date.now() - t0 < 10) { q[qi++]() }
      if (qi < q.length) requestAnimationFrame(drain)
    }
    for (const grpKey of Object.keys(groups)) {
      const fam = groups[grpKey]
      if (fam.length > 1) {
        // 商品头：这个商品一共多少 —— 老板要的「总数量」
        const total = fiSpecTotalStock(fam)
        const title = document.createElement('div'); title.className = 'sectitle'
        title.innerHTML = '<span class="tag" style="font-size:14px">' + escHtml(fiSpecProductName(fam[0])) + '</span>' +
          '<span style="font-size:13px">' + fam.length + ' 个规格 · 共 <b style="color:' + (total > 0 ? 'var(--green)' : 'var(--red)') + '">' + total + '</b></span>'
        q.push(function () { app.appendChild(title) })
      }

      fam.forEach(p => {
        const total = p.total_stock || 0
        const low = total < (p.min_stock || 5)
        const isHot = p.is_hot === 1
        const isClear = p.is_clearance === 1
        const badges = (isHot ? '<span class="badge" style="background:var(--blue);color:#fff">热销</span> ' : '') +
          (isClear ? '<span style="background:#f59e0b;color:#fff;border-radius:4px;padding:1px 6px;font-size:12px;font-weight:800">' + FiIcon('tag', 12) + '处理货</span> ' : '')
        const card = document.createElement('div'); card.className = 'card'; card.style.cssText = 'margin:0 16px 8px;padding:12px 14px'
        // 缩略图（点它也能拍照/换图）：没图时给一个虚线相机位，让人一眼知道这儿能挂图。
        // loading=lazy：300+ 个 SKU 一次性上屏时，屏幕外的图不要立刻都去请求。
        const photoUrl = p.photo_path ? FiPhoto.productPhotoUrl(p.photo_path, p.updated_at) : ''
        const thumb = photoUrl
          ? '<img data-photo-img src="' + photoUrl + '" alt="" loading="lazy" style="width:52px;height:52px;object-fit:cover;border-radius:8px;border:2px solid var(--ink);flex:none;background:var(--card)">'
          : '<div data-photo-img style="width:52px;height:52px;border-radius:8px;border:2px dashed var(--line);display:flex;align-items:center;justify-content:center;font-size:20px;flex:none;color:var(--sub)">' + FiIcon('camera', 15) + '</div>'
        card.innerHTML =
          '<div class="split" style="align-items:center;gap:10px">' +
            thumb +
            '<div style="min-width:0">' +
              '<div class="font-bold" style="font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + badges + prodName(p) + '</div>' +
              '<div class="text-sm" style="color:var(--sub);margin-top:2px">' + (p.sku_code || '') + '</div>' +
            '</div>' +
            '<div class="text-right" style="flex:none">' +
              '<div class="font-bolder" style="font-size:20px;' + (low ? 'color:var(--red)' : 'color:var(--green)') + '">' + total + ' ' + escHtml(p.unit || '件') + (low ? ' ⚠' : '') + '</div>' +
              '<div class="text-sm" style="color:var(--sub)">' + (p.suggest_price ? fmt(p.suggest_price) : '未定价') + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-top:8px">' +
            '<button data-adj style="flex:1;height:42px;border-radius:10px;border:none;background:var(--blue);color:#fff;font-size:15px;font-weight:800">' + FiIcon('pulse', 15) + ' 改数量</button>' +
            '<button data-detail style="flex:1.5;height:42px;border-radius:10px;border:1px solid var(--line);background:var(--card2);color:var(--blue);font-size:14px;font-weight:800">' + FiIcon('clipboard', 15) + ' 详情 / 改价 · 换图</button>' +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)">' +
            '<button data-hot style="flex:1;height:36px;border-radius:10px;border:1px solid var(--line);background:var(--card2);font-size:13px;font-weight:800;background:' + (isHot ? '#ff6b6b' : 'var(--card)') + ';color:' + (isHot ? '#fff' : 'var(--ink)') + '">' + FiIcon('bolt', 12) + ' 热销</button>' +
            '<button data-clear style="flex:1;height:36px;border-radius:10px;border:1px solid var(--line);background:var(--card2);font-size:13px;font-weight:800;background:' + (isClear ? '#f59e0b' : 'var(--card)') + ';color:' + (isClear ? '#fff' : 'var(--ink)') + '">' + FiIcon('tag', 12) + ' 处理货</button>' +
            '<button data-pic style="flex:0 0 76px;height:36px;border-radius:10px;border:1px solid var(--line);background:var(--card2);font-size:13px;font-weight:800;background:var(--card);color:var(--ink)">' + FiIcon('camera', 15) + ' ' + (p.photo_path ? '换图' : '拍照') + '</button>' +
            '<button data-del style="flex:0 0 72px;height:36px;border-radius:10px;border:1px solid var(--red);background:#fff;font-size:13px;font-weight:800;background:#fff;color:var(--red)">' + FiIcon('trash', 15) + ' 删除</button>' +
          '</div>'
        card.onclick = () => { try { localStorage.setItem('fi-pos-preselect', String(p.id)) } catch {} navigate('pos') }
        const hotBtn = card.querySelector('[data-hot]')
        const clearBtn = card.querySelector('[data-clear]')
        const detailBtn = card.querySelector('[data-detail]')
        const adjBtn = card.querySelector('[data-adj]')
        const picBtn = card.querySelector('[data-pic]')
        const picThumb = card.querySelector('[data-photo-img]')
        const delBtn = card.querySelector('[data-del]')
        if (detailBtn) detailBtn.onclick = (e) => { e.stopPropagation(); openDetail(p) }
        if (adjBtn) adjBtn.onclick = (e) => { e.stopPropagation(); openAdjustSheet(p) }
        if (hotBtn) hotBtn.onclick = async (e) => { e.stopPropagation(); await toggleMark(p.id, 'is_hot', !isHot) }
        if (clearBtn) clearBtn.onclick = async (e) => { e.stopPropagation(); await toggleMark(p.id, 'is_clearance', !isClear) }
        if (picBtn) picBtn.onclick = async (e) => { e.stopPropagation(); await pickProductPhoto(p) }
        if (picThumb) picThumb.onclick = async (e) => { e.stopPropagation(); await pickProductPhoto(p) }
        if (delBtn) delBtn.onclick = async (e) => { e.stopPropagation(); await removeProduct(p) }
        q.push(function () { app.appendChild(card) })
      })
    }

    const foot = document.createElement('div'); foot.className = 'text-center'; foot.style.cssText = 'padding:16px;color:var(--sub);font-size:13px'
    foot.innerHTML = '点商品可去开单页卖它；「详情」里能改价/改单位/换图；点左边相机位或「' + FiIcon('camera', 13) + '」也能拍图；删除只能删没入过库、没流水的新建错档（有历史的可改停产）'
    q.push(function () { app.appendChild(foot) })
    drain()
  }

  render()
  search('')
})
