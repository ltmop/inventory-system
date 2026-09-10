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

    // 三个入口：AI拍照建档 / 手动建档 / 扫码入库
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
    row.appendChild(photo); row.appendChild(manual); row.appendChild(scan)
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
      '<div class="fld"><label>商品名称</label><input id="f-name" placeholder="例：农夫山泉 550ml"></div>' +
      '<div class="fldrow">' +
        '<div class="fld"><label>分类</label><select id="f-cat"><option>其他</option></select></div>' +
        '<div class="fld"><label>进价（元）</label><input id="f-cost" type="number" step="0.01" placeholder="0.00"></div>' +
      '</div>' +
      '<div class="fldrow">' +
        '<div class="fld"><label>计量单位</label><select id="f-unit"><option value="件">件</option><option value="米">米</option></select></div>' +
        '<div class="fld"><label>数量</label><input id="f-qty" type="number" step="0.1" placeholder="多少个 / 多少米？"></div>' +
      '</div>' +
      '<div class="fld"><label id="f-expiry-label">到期日（可选）</label><input id="f-expiry" type="date" placeholder="2026-12-31"></div>' +
      '<button class="okbtn" id="f-ok">完成入库</button>'
    app.appendChild(form)

    // 动态分类：从后端拉取（通用版分类可配置）
    try {
      invoke('category:list', {}).then((cats) => {
        const sel = document.getElementById('f-cat')
        if (sel && Array.isArray(cats) && cats.length > 0) {
          sel.innerHTML = cats.map((c) => '<option>' + c.name + '</option>').join('')
        }
      }).catch(() => { /* 拉取失败保持默认 */ })
    } catch (e) { /* 忽略 */ }

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
            cost_price: cost, suggest_price: 0, status: '待盘点', unit: '件',
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

  // 进货单批量入库：拍照 → AI 识别全部商品行 → 逐行核对数量/价格 → 一次入库
  async function photoFlow() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment'
    input.onchange = async function () {
      if (!input.files || !input.files[0]) return
      const file = input.files[0]
      toast('AI 识别进货单中…')
      try {
        const base64 = await compressPhoto(file)
        const r = await api('ai:photoDraft', { imageBase64: base64, mimeType: 'image/jpeg' })
        if (!r || !r.ok || !r.items || r.items.length === 0) {
          showCreateForm('', null)
          toast(r?.detail || 'AI 没识别出商品，手动填吧')
          return
        }
        showBatchReview(r.items)
      } catch {
        showCreateForm('', null)
        toast('AI 不可用，手动填吧')
      }
    }
    input.click()
  }

  // 进货单核对页：列出 AI 识别的所有商品，可改数量/价格，点"全部入库"
  function showBatchReview(items) {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--paper);z-index:350;display:flex;flex-direction:column;color:var(--ink)'
    overlay.innerHTML =
      '<div style="padding:14px 16px;border-bottom:3px solid var(--ink);display:flex;align-items:center;gap:8px">' +
        '<button id="br-back" style="width:40px;height:40px;border-radius:8px;border:2px solid var(--ink);background:var(--card);font-size:18px">✕</button>' +
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
          '<div class="text-xs text-muted">' + (it.category || '其他') + (isNew ? ' · 🆕 新商品' : ' · 已有商品') + '</div></div>' +
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
    const qty = unit === '米' ? Math.round((parseFloat(qtyStr) || 0) * 10) / 10 : (parseInt(qtyStr, 10) || 0)
    if (!name) { toast('填个商品名就能入库了'); return }
    if (!(qty > 0)) { toast('填个数量'); return }
    const cost = costStr ? Math.round(parseFloat(costStr) * 100) : 0
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
        cost_price: cost, suggest_price: 0, status: '待盘点', unit: unit,
      })
      await api('inbound:create', { productId: r.id, quantity: qty, costPrice: cost, location: '', operator: getOperator(), expiryDate: expiry })
      showStamp('已入库', name + ' × ' + qty + (unit === '米' ? '米' : ''), true)
      form.classList.remove('show')
      document.getElementById('ai-tag').classList.remove('show')
      ;['f-name', 'f-cost', 'f-qty'].forEach(id => document.getElementById(id).value = '')
      loadRecents()
    } catch (e) { toast('入库失败: ' + e.message) }
  }

  render()
})
