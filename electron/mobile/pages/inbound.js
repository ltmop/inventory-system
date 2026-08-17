// inbound.js: 入库页 —— 拍照建档 / 扫码入库 双入口 → 已入库印章
page('inbound', function (app) {
  let recentInbounds = []
  loadRecents()

  async function loadRecents() {
    try {
      const tx = await api('report:today')
      recentInbounds = (tx.recent || []).filter(t => t.type === 'in').slice(0, 10)
    } catch { recentInbounds = [] }
    render()
  }

  function render() {
    app.innerHTML = ''

    // 双按钮
    const row = document.createElement('div'); row.className = 'bigrow'
    const photo = document.createElement('button'); photo.className = 'big photo'
    photo.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="28" height="28"><path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>拍照建档'
    photo.onclick = photoFlow
    const scan = document.createElement('button'); scan.className = 'big'
    scan.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="28" height="28"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M4 12h16"/></svg>扫码入库'
    scan.onclick = () => openScanner(onScan, '扫条码入库')
    row.appendChild(photo); row.appendChild(scan)
    app.appendChild(row)

    // 搜索
    const searchDiv = document.createElement('div'); searchDiv.className = 'scanrow'
    const input = document.createElement('input'); input.className = 'search'; input.placeholder = '没有相机？打字搜或新建商品'
    input.style.width = '100%'; input.onchange = () => { const v = input.value.trim(); if (v) onScan(v) }
    searchDiv.appendChild(input)
    app.appendChild(searchDiv)

    // 建档表单（拍照或扫码后展开）
    const form = document.createElement('div'); form.className = 'form-card'; form.id = 'inbound-form'
    form.innerHTML =
      '<div class="ft"><b>新商品建档</b><span class="aitag" id="ai-tag">AI 已预填</span></div>' +
      '<div class="fld"><label>商品名称</label><input id="f-name" placeholder="例：原味苏打饼干 400g"></div>' +
      '<div class="fldrow">' +
        '<div class="fld"><label>分类</label><select id="f-cat"><option>食品饮料</option><option>日用百货</option><option>五金工具</option><option>电子电器</option><option>服饰鞋帽</option><option>文具办公</option><option>清洁日化</option><option>其他</option></select></div>' +
        '<div class="fld"><label>进价（元）</label><input id="f-cost" type="number" step="0.01" placeholder="0.00"></div>' +
      '</div>' +
      '<div class="fldrow">' +
        '<div class="fld"><label>计量单位</label><select id="f-unit"><option value="件">件</option><option value="米">米</option></select></div>' +
        '<div class="fld"><label>数量</label><input id="f-qty" type="number" step="0.1" placeholder="多少个 / 多少米？"></div>' +
      '</div>' +
      '<div class="fld"><label id="f-expiry-label">到期日（可选）</label><input id="f-expiry" type="date" placeholder="2026-12-31"></div>' +
      '<button class="okbtn" id="f-ok">完成入库</button>'
    app.appendChild(form)

    document.getElementById('f-ok').onclick = finishInbound

    // 今日入库记录
    if (recentInbounds.length > 0) {
      const recTitle = document.createElement('div'); recTitle.className = 'sectitle'
      recTitle.innerHTML = '<span class="tag" style="background:var(--ink)">今日入库</span>'
      app.appendChild(recTitle)
      const recs = document.createElement('div'); recs.style.padding = '0 16px 14px'
      recentInbounds.forEach(t => {
        const name = (t.brand || '') + ' ' + (t.model || '') || t.sku_code || '-'
        const time = (t.timestamp || '').slice(11, 16)
        const div = document.createElement('div'); div.className = 'rec'
        div.innerHTML =
          '<div class="ph" style="background:var(--green)">' + (name[0] || '?') + '</div>' +
          '<div class="info"><div class="n">' + name + '</div><div class="d">' + time + '</div></div>' +
          '<div class="q">+' + t.quantity + '</div>'
        recs.appendChild(div)
      })
      app.appendChild(recs)
    }
  }

  // 通用版：到期日全部可选（填了该批次走保质期管理，不填当普通商品）
  const EXPIRY_REQUIRED_CATEGORIES = []

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
      // 米商品（鱼线）按米入库，允许小数；件商品按个，整数
      const isMeter = p.unit === '米'
      const qtyStr = prompt('「' + name + '」\n库存 ' + (p.total_stock || 0) + '，入多少' + (isMeter ? '米' : '个') + '？', '1')
      const qty = isMeter ? Math.round((parseFloat(qtyStr) || 0) * 10) / 10 : (parseInt(qtyStr, 10) || 0)
      if (!(qty > 0)) return
      const cost = prompt('进价多少元？', String((p.cost_price || 0) / 100))
      // 到期日（可选）：填了该批次走保质期管理，不填当普通商品
      const needExpiry = false
      promptDate('到期日（有保质期的商品填，可选）', async (expiry) => {
        const payload = {
          productId: p.id, quantity: qty,
          costPrice: cost ? Math.round(parseFloat(cost) * 100) : p.cost_price,
          location: p.location || '', operator: '手机',
        }
        if (expiry) payload.expiryDate = expiry
        try {
          await api('inbound:create', payload)
          showStamp('已入库', name + ' × ' + qty, true)
          loadRecents()
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
    document.getElementById('f-qty').value = ''
    // 到期日字段重置：清空上次的值
    const expiryEl = document.getElementById('f-expiry')
    if (expiryEl) expiryEl.value = ''
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

  async function photoFlow() {
    // 拍照 → 调 ai:photoDraft → 预填表单
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment'
    input.onchange = async function () {
      if (!input.files || !input.files[0]) return
      const file = input.files[0]
      const reader = new FileReader()
      reader.onload = async function () {
        const base64 = reader.result.split(',')[1]
        toast('AI 识别中…')
        try {
          const r = await api('ai:photoDraft', { imageBase64: base64, mimeType: file.type })
          if (r && r.ok && r.items && r.items.length > 0) {
            const item = r.items[0]
            showCreateForm(item.sku_code || '', {
              brand: item.brand, model: item.model, category: item.category,
              cost_price_yuan: item.cost_price_fen ? (item.cost_price_fen / 100).toFixed(2) : '',
            })
            toast('AI 已填好，你只需填数量')
          } else {
            showCreateForm('', null)
            toast('AI 识别失败，请手动填写')
          }
        } catch {
          showCreateForm('', null)
          toast('AI 不可用，请手动填写')
        }
      }
      reader.readAsDataURL(file)
    }
    input.click()
  }

  async function finishInbound() {
    const form = document.getElementById('inbound-form')
    const name = document.getElementById('f-name').value.trim()
    const cat = document.getElementById('f-cat').value
    const costStr = document.getElementById('f-cost').value
    const unitEl = document.getElementById('f-unit')
    const unit = unitEl ? unitEl.value : '件'
    const qtyStr = document.getElementById('f-qty').value
    const qty = unit === '米' ? Math.round((parseFloat(qtyStr) || 0) * 10) / 10 : (parseInt(qtyStr, 10) || 0)
    if (!name) { toast('填个商品名就能入库了'); return }
    if (!(qty > 0)) { toast('填个数量'); return }
    const cost = costStr ? Math.round(parseFloat(costStr) * 100) : 0
    const code = form.getAttribute('data-code') || ''
    // 到期日（可选）：填了该批次走保质期管理，不填当普通商品
    const expiryEl = document.getElementById('f-expiry')
    const expiry = expiryEl && expiryEl.value ? expiryEl.value : undefined
    try {
      const r = await api('product:create', {
        sku_code: code, barcode: code, category: cat, brand: '', model: name,
        cost_price: cost, suggest_price: 0, status: '待盘点', unit: unit,
      })
      await api('inbound:create', { productId: r.id, quantity: qty, costPrice: cost, location: '', operator: '手机', expiryDate: expiry })
      showStamp('已入库', name + ' × ' + qty + (unit === '米' ? '米' : ''), true)
      form.classList.remove('show')
      document.getElementById('ai-tag').classList.remove('show')
      ;['f-name', 'f-cost', 'f-qty'].forEach(id => document.getElementById(id).value = '')
      loadRecents()
    } catch (e) { toast('入库失败: ' + e.message) }
  }

  render()
})
