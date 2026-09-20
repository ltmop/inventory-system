// product.js: 商品详情 / 编辑 —— 从库存页卡片上的「详情」进来
//
// 为什么要有这一页：库存卡片上只有 热销 / 处理货 / 拍照 / 删除 四个开关，
// 改价、改单位、改预警线、改货位在手机上原来**没有入口**（得回电脑）。
// 这一页补齐，并且把「去开单卖它」放在最显眼的位置，不拖慢柜台节奏。
//
// 数据来源：库存页把那一行商品 JSON 塞进 localStorage('fi-product-edit') 带过来，
// 沿用开单页 fi-pos-preselect 的现成约定，**不新增后端通道**。
// 保存走 product:update（命令层唯一入口）；图片走 FiPhoto（lib/photo.js）。
page('product', function (app) {
  let p = null
  try { p = JSON.parse(localStorage.getItem('fi-product-edit') || 'null') } catch (e) { p = null }
  if (!p || !p.id) {
    app.innerHTML = '<div style="padding:40px;text-align:center">' +
      '<div style="font-size:44px">📦</div>' +
      '<div class="font-bold" style="margin-top:8px">没拿到商品</div>' +
      '<div class="text-sm text-muted" style="margin-top:4px">回库存页重新点一次「详情」</div>' +
      '<div id="pd-back2" style="margin-top:16px;height:46px;line-height:46px;border-radius:10px;border:2px solid var(--ink);background:var(--card);font-weight:800">回库存页</div>' +
      '</div>'
    const b = document.getElementById('pd-back2')
    if (b) b.onclick = function () { navigate('stock') }
    return
  }

  let cats = null   // [{name}] 分类
  let units = null  // [{name,allow_decimal}] 单位
  let busy = false

  const STATUSES = ['在售', '待盘点', '已盘点', '已售罄', '停产']
  const toYuan = (cents) => (cents === null || cents === undefined || cents === '' ? '' : (Number(cents) / 100).toFixed(2))
  const toCents = (s) => {
    const t = String(s === null || s === undefined ? '' : s).trim()
    if (!t) return null
    const v = parseFloat(t)
    return isFinite(v) && v >= 0 ? Math.round(v * 100) : null
  }
  const opt = (v, cur) => '<option value="' + escHtml(v) + '"' + (String(v) === String(cur == null ? '' : cur) ? ' selected' : '') + '>' + escHtml(v) + '</option>'

  // 低库存判据与库存页/桌面端同口径：总库存 < 预警线（没设预警线按 5）
  function isLow(prod) { return (prod.total_stock || 0) < (prod.min_stock || 5) }

  function photoBlock() {
    const url = p.photo_path ? FiPhoto.productPhotoUrl(p.photo_path, p.updated_at) : ''
    return url
      ? '<img id="pd-img" src="' + url + '" alt="" style="width:100%;max-height:260px;object-fit:contain;background:#fff;border-radius:12px;border:2px solid var(--ink)">'
      : '<div id="pd-img" style="height:150px;border-radius:12px;border:2px dashed var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--sub)"><div style="font-size:38px">📷</div><div class="text-sm" style="margin-top:6px">还没有图片，点这里拍一张</div></div>'
  }

  function render() {
    app.innerHTML = ''

    // ---- 顶部：返回 + 标题 ----
    const bar = document.createElement('div')
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 16px'
    bar.innerHTML =
      '<button id="pd-back" style="width:42px;height:42px;border-radius:10px;border:2px solid var(--ink);background:var(--card);font-size:18px;flex:none">←</button>' +
      '<div style="min-width:0"><div class="font-bold" style="font-size:17px">商品详情</div>' +
      '<div class="text-sm text-muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(p.sku_code || '无条码') + '</div></div>'
    app.appendChild(bar)

    // ---- 图片 ----
    const imgWrap = document.createElement('div')
    imgWrap.style.cssText = 'padding:0 16px'
    imgWrap.innerHTML = photoBlock()
    app.appendChild(imgWrap)
    const imgEl = document.getElementById('pd-img')
    if (imgEl) imgEl.onclick = changePhoto

    // ---- 概览：库存 / 预警线 / 货位 ----
    const total = p.total_stock || 0
    const low = isLow(p)
    const head = document.createElement('div')
    head.className = 'card'
    head.innerHTML =
      '<div class="font-bold" style="font-size:18px">' + escHtml(prodName(p)) + '</div>' +
      '<div class="text-sm text-muted" style="margin-top:2px">' + escHtml(p.category || '其他') + (p.brand ? ' · ' + escHtml(p.brand) : '') + '</div>' +
      '<div style="display:flex;gap:14px;margin-top:10px;align-items:baseline">' +
        '<div><div style="font-size:26px;font-weight:900;' + (low ? 'color:var(--red)' : 'color:var(--green)') + '">' + total + '</div>' +
        '<div class="text-sm text-muted">' + escHtml(p.unit || '件') + (low ? ' · 低于预警' : '') + '</div></div>' +
        '<div class="text-sm text-muted">预警线 ' + (p.min_stock == null ? '未设（按 5）' : p.min_stock) + '<br>货位 ' + escHtml(p.location || '未填') + '</div>' +
      '</div>'
    app.appendChild(head)

    // ---- 可编辑字段 ----
    const form = document.createElement('div')
    form.className = 'card'
    form.innerHTML =
      '<div class="font-bold" style="margin-bottom:8px">改资料</div>' +
      '<div class="fld"><label>商品名称</label><input id="pd-model" value="' + escHtml(p.model || '') + '" placeholder="例：老鬼 918 腥味"></div>' +
      '<div class="fldrow">' +
        '<div class="fld"><label>品牌</label><input id="pd-brand" value="' + escHtml(p.brand || '') + '"></div>' +
        '<div class="fld"><label>分类</label><select id="pd-cat">' + opt(p.category || '其他', p.category || '其他') + '</select></div>' +
      '</div>' +
      '<div class="fldrow">' +
        '<div class="fld"><label>计量单位</label><select id="pd-unit">' + opt(p.unit || '件', p.unit || '件') + '</select></div>' +
        '<div class="fld"><label>状态</label><select id="pd-status">' + STATUSES.map((s) => opt(s, p.status || '在售')).join('') + '</select></div>' +
      '</div>' +
      '<div class="fldrow">' +
        '<div class="fld"><label>进价（元）</label><input id="pd-cost" type="number" step="0.01" inputmode="decimal" value="' + toYuan(p.cost_price) + '"></div>' +
        '<div class="fld"><label>建议售价（元）</label><input id="pd-suggest" type="number" step="0.01" inputmode="decimal" value="' + toYuan(p.suggest_price) + '" placeholder="留空=未定价"></div>' +
      '</div>' +
      '<div class="fldrow">' +
        '<div class="fld"><label>库存预警线</label><input id="pd-min" type="number" step="1" inputmode="numeric" value="' + (p.min_stock == null ? '' : p.min_stock) + '" placeholder="留空=不预警"></div>' +
        '<div class="fld"><label>货位</label><input id="pd-loc" value="' + escHtml(p.location || '') + '" placeholder="例：A区3号架"></div>' +
      '</div>' +
      '<div class="text-sm text-muted" id="pd-unit-hint" style="margin-top:4px"></div>' +
      '<button id="pd-save" class="okbtn" style="margin-top:10px">保存修改</button>'
    app.appendChild(form)

    // ---- 主要动作 ----
    const acts = document.createElement('div')
    acts.style.cssText = 'padding:0 16px 20px'
    acts.innerHTML =
      '<button id="pd-sell" style="width:100%;height:56px;border:none;border-radius:12px;background:var(--green);color:#fff;font-size:18px;font-weight:900">🛒 去开单卖它</button>' +
      '<button id="pd-pic" style="width:100%;height:48px;margin-top:10px;border-radius:12px;border:2px solid var(--ink);background:var(--card);font-size:15px;font-weight:800">📷 ' + (p.photo_path ? '换一张图片' : '拍一张图片') + '</button>' +
      '<button id="pd-del" style="width:100%;height:48px;margin-top:10px;border-radius:12px;border:2px solid var(--red);background:#fff;color:var(--red);font-size:15px;font-weight:800">🗑 删除（有历史会引导改停产）</button>'
    app.appendChild(acts)

    document.getElementById('pd-back').onclick = function () { navigate('stock') }
    document.getElementById('pd-sell').onclick = goSell
    document.getElementById('pd-pic').onclick = changePhoto
    document.getElementById('pd-del').onclick = removeProduct
    document.getElementById('pd-save').onclick = save
    const unitSel = document.getElementById('pd-unit')
    if (unitSel) unitSel.onchange = updateUnitHint
    updateUnitHint()
    fillOptions()
  }

  // 单位提示：按斤/公斤/克这类可小数单位要提醒一句（与桌面端 allow_decimal 同源）
  function updateUnitHint() {
    const hint = document.getElementById('pd-unit-hint')
    const sel = document.getElementById('pd-unit')
    if (!hint || !sel) return
    const u = (units || []).find((x) => x.name === sel.value)
    if (u && u.allow_decimal) hint.textContent = '「' + u.name + '」可以填小数（例：0.5' + u.name + '），按斤/按米卖的散货选它没错。'
    else hint.textContent = ''
  }

  // 分类/单位下拉：从后端拉真值（与桌面端同一份表），拉不到就保留当前值不报错
  async function fillOptions() {
    if (!cats || !units) {
      try { const c = await api('category:list'); if (Array.isArray(c)) cats = c.map((x) => (x && x.name) || x) } catch (e) { /* 保留当前值 */ }
      try { const u = await api('unit:list'); if (Array.isArray(u)) units = u } catch (e) { /* 保留当前值 */ }
    }
    const catSel = document.getElementById('pd-cat')
    if (catSel && cats && cats.length) {
      const cur = p.category || '其他'
      const list = cats.indexOf(cur) >= 0 ? cats : [cur].concat(cats)
      catSel.innerHTML = list.map((c) => opt(c, cur)).join('')
    }
    const unitSel = document.getElementById('pd-unit')
    if (unitSel && units && units.length) {
      const cur = p.unit || '件'
      const names = units.map((u) => u.name)
      const list = names.indexOf(cur) >= 0 ? units : [{ name: cur }].concat(units)
      unitSel.innerHTML = list.map((u) => '<option value="' + escHtml(u.name) + '"' + (u.name === cur ? ' selected' : '') + '>' + escHtml(u.name) + (u.allow_decimal ? '（可小数）' : '') + '</option>').join('')
    }
    updateUnitHint()
  }

  async function save() {
    if (busy) return
    const model = document.getElementById('pd-model').value.trim()
    const brand = document.getElementById('pd-brand').value.trim()
    if (!model && !brand) { toast('商品名和品牌至少填一个，不然库存里认不出来'); return }
    const cost = toCents(document.getElementById('pd-cost').value)
    if (cost === null) { toast('进价要填个数字（可以填 0）'); return }
    const minRaw = document.getElementById('pd-min').value.trim()
    const minStock = minRaw === '' ? null : (parseInt(minRaw, 10) || 0)
    busy = true
    const btn = document.getElementById('pd-save')
    if (btn) { btn.disabled = true; btn.textContent = '保存中…' }
    try {
      const updated = await api('product:update', {
        id: p.id,
        model: model,
        brand: brand,
        category: document.getElementById('pd-cat').value,
        unit: document.getElementById('pd-unit').value,
        status: document.getElementById('pd-status').value,
        cost_price: cost,
        suggest_price: toCents(document.getElementById('pd-suggest').value), // 留空 = 清成未定价
        min_stock: minStock,
        location: document.getElementById('pd-loc').value.trim(),
        operator: getOperator(),
      })
      // 服务端返回的是更新后的整行（含新的 updated_at），直接接着用它渲染
      if (updated && updated.id) p = Object.assign({}, p, updated)
      toast('已保存')
      render()
    } catch (e) {
      toast('保存失败：' + (e.message || ''))
      if (btn) { btn.disabled = false; btn.textContent = '保存修改' }
    }
    busy = false
  }

  async function changePhoto() {
    try {
      const b64 = await FiPhoto.pickPhoto()
      if (!b64) return
      toast('正在上传图片…')
      const path = await FiPhoto.saveProductPhoto(p.id, b64)
      p.photo_path = path
      p.updated_at = new Date().toISOString()   // 换图后文件名不变，靠它穿透缓存
      toast('图片已保存')
      render()
    } catch (e) { toast('图片保存失败：' + (e.message || '')) }
  }

  function goSell() {
    try { localStorage.setItem('fi-pos-preselect', String(p.id)) } catch (e) { /* 忽略 */ }
    navigate('pos')
  }

  // 删除：服务端只允许删「无批次、无流水」的；否则引导改「停产」（与库存页同一套口径）
  async function removeProduct() {
    const name = prodName(p)
    if (!confirm('删除「' + name + '」？\n\n只能删没有入库批次和流水的商品；有历史的会被拦下，可以改成「停产」。')) return
    try {
      const r = await api('product:delete', { id: p.id, operator: getOperator() })
      if (r && r.ok === false) {
        const why = r.reason || '该商品有库存或流水记录，不能删除'
        if (confirm(why + '\n\n改成「停产」？停产后不出现在开单热销榜，但历史账目完整保留。')) {
          try {
            await api('product:update', { id: p.id, status: '停产', operator: getOperator() })
            p.status = '停产'
            toast('已改为停产')
            render()
          } catch (e2) { toast('改停产失败：' + (e2.message || '')) }
        }
        return
      }
      toast('已删除「' + name + '」')
      navigate('stock')
    } catch (e) { toast('删除失败：' + (e.message || '')) }
  }

  render()
})
