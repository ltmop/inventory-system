// stock.js: 库存查询 —— 打开直接显示全部 SKU，按分类/货位分组，大字卡片（40岁+友好）
// 2026-09-20：加「分类筛选」（不再一个个翻）+ 「删除 / 改停产」（服务端只允许删无批次无流水的商品）
page('stock', function (app) {
  let keyword = ''
  let cat = ''            // 选中的分类（'' = 全部）
  let lowOnly = false     // 只看低库存
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

  function applyFilter() {
    results = all.filter(p => {
      if (cat && (p.category || '其他') !== cat) return false
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

  function render() {
    app.innerHTML = ''

    // 搜索框
    const sr = document.createElement('div'); sr.className = 'scanrow'
    const inp = document.createElement('input'); inp.className = 'search'; inp.placeholder = '🔍 输入品名/条码/SKU 过滤...'; inp.value = keyword; inp.style.width = '100%'
    inp.oninput = (e) => search(e.target.value.trim())
    sr.appendChild(inp); app.appendChild(sr)

    // 扫码查库存
    const btn = document.createElement('button'); btn.className = 'scanbtn'; btn.style.margin = '10px 16px'; btn.style.width = 'calc(100% - 32px)'
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M4 12h16"/></svg>扫码查库存'
    btn.onclick = () => openScanner((code) => { if (code) { inp.value = code; search(code) } }, '扫码查库存')
    app.appendChild(btn)

    // ---- 分类筛选条（横滑）：不用再一个个翻 ----
    const cats = {}
    all.forEach(p => { const c = p.category || '其他'; cats[c] = (cats[c] || 0) + 1 })
    const catNames = Object.keys(cats).sort((a, b) => cats[b] - cats[a])
    if (catNames.length > 1 || cat) {
      const bar = document.createElement('div')
      bar.style.cssText = 'display:flex;gap:8px;overflow-x:auto;padding:2px 16px 10px;-webkit-overflow-scrolling:touch'
      const mk = (label, on, fn) => {
        const b = document.createElement('button')
        b.textContent = label
        b.style.cssText = 'flex:none;height:38px;padding:0 14px;border-radius:19px;font-size:14px;font-weight:800;border:2px solid var(--ink);white-space:nowrap;' +
          (on ? 'background:var(--ink);color:var(--paper)' : 'background:var(--card);color:var(--ink)')
        b.onclick = fn
        return b
      }
      bar.appendChild(mk('全部 ' + all.length, cat === '' && !lowOnly, () => { cat = ''; applyFilter() }))
      bar.appendChild(mk('🔴 只看低库存', lowOnly, () => { lowOnly = !lowOnly; applyFilter() }))
      catNames.forEach(c => bar.appendChild(mk(c + ' ' + cats[c], cat === c, () => { cat = (cat === c ? '' : c); applyFilter() })))
      app.appendChild(bar)
    }

    if (results.length === 0) {
      const empty = document.createElement('div'); empty.className = 'text-center text-muted'; empty.style.padding = '30px'; empty.style.fontSize = '15px'
      empty.textContent = keyword ? '没有找到「' + keyword + '」' : (cat || lowOnly ? '这个筛选下没有商品' : '加载中...')
      app.appendChild(empty)
      return
    }

    // 顶部统计（大字）
    const lowCount = results.filter(p => (p.total_stock || 0) < (p.min_stock || 5)).length
    const stat = document.createElement('div'); stat.style.cssText = 'padding:8px 18px 12px;font-size:15px;font-weight:700'
    stat.textContent = '共 ' + results.length + ' 个SKU' + (cat ? '（' + cat + '）' : '') + (lowCount > 0 ? ' · 🔴 低库存 ' + lowCount + ' 个' : ' · 库存都充足')
    app.appendChild(stat)

    // 低库存置顶
    const sorted = [...results].sort((a, b) => {
      const aLow = (a.total_stock || 0) < (a.min_stock || 5) ? 1 : 0
      const bLow = (b.total_stock || 0) < (b.min_stock || 5) ? 1 : 0
      if (aLow !== bLow) return bLow - aLow
      return (a.category || '').localeCompare(b.category || '')
    })

    // 按货位分组（有 location 的优先），没货位的归到品类组
    const groups = {}
    sorted.forEach(p => {
      const loc = (p.location || '').trim()
      const key = loc || (p.category || '其他')
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
      const isLoc = groups[grpKey].every(p => (p.location || '').trim() === grpKey) && grpKey.trim()
      const title = document.createElement('div'); title.className = 'sectitle'
      title.innerHTML = '<span class="tag" style="font-size:14px">' + (isLoc ? '📍 ' : '') + grpKey + '</span><span style="font-size:13px">' + groups[grpKey].length + ' 个</span>'
      q.push(function () { app.appendChild(title) })

      groups[grpKey].forEach(p => {
        const total = p.total_stock || 0
        const low = total < (p.min_stock || 5)
        const isHot = p.is_hot === 1
        const isClear = p.is_clearance === 1
        const badges = (isHot ? '<span style="background:#ff6b6b;color:#fff;border-radius:4px;padding:1px 6px;font-size:12px;font-weight:800">🔥热销</span> ' : '') +
          (isClear ? '<span style="background:#f59e0b;color:#fff;border-radius:4px;padding:1px 6px;font-size:12px;font-weight:800">🏷处理货</span> ' : '')
        const card = document.createElement('div'); card.className = 'card'; card.style.cssText = 'margin:0 16px 8px;padding:12px 14px'
        card.innerHTML =
          '<div class="split" style="align-items:center">' +
            '<div style="min-width:0">' +
              '<div class="font-bold" style="font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + badges + prodName(p) + '</div>' +
              '<div class="text-sm" style="color:var(--sub);margin-top:2px">' + (p.sku_code || '') + '</div>' +
            '</div>' +
            '<div class="text-right" style="flex:none">' +
              '<div class="font-bolder" style="font-size:20px;' + (low ? 'color:var(--red)' : 'color:var(--green)') + '">' + total + ' 件' + (low ? ' ⚠' : '') + '</div>' +
              '<div class="text-sm" style="color:var(--sub)">' + (p.suggest_price ? fmt(p.suggest_price) : '未定价') + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)">' +
            '<button data-hot style="flex:1;height:36px;border-radius:8px;border:2px solid var(--ink);font-size:13px;font-weight:800;background:' + (isHot ? '#ff6b6b' : 'var(--card)') + ';color:' + (isHot ? '#fff' : 'var(--ink)') + '">🔥 热销</button>' +
            '<button data-clear style="flex:1;height:36px;border-radius:8px;border:2px solid var(--ink);font-size:13px;font-weight:800;background:' + (isClear ? '#f59e0b' : 'var(--card)') + ';color:' + (isClear ? '#fff' : 'var(--ink)') + '">🏷 处理货</button>' +
            '<button data-del style="flex:0 0 84px;height:36px;border-radius:8px;border:2px solid var(--red);font-size:13px;font-weight:800;background:#fff;color:var(--red)">🗑 删除</button>' +
          '</div>'
        card.onclick = () => { try { localStorage.setItem('fi-pos-preselect', String(p.id)) } catch {} navigate('pos') }
        const hotBtn = card.querySelector('[data-hot]')
        const clearBtn = card.querySelector('[data-clear]')
        const delBtn = card.querySelector('[data-del]')
        if (hotBtn) hotBtn.onclick = async (e) => { e.stopPropagation(); await toggleMark(p.id, 'is_hot', !isHot) }
        if (clearBtn) clearBtn.onclick = async (e) => { e.stopPropagation(); await toggleMark(p.id, 'is_clearance', !isClear) }
        if (delBtn) delBtn.onclick = async (e) => { e.stopPropagation(); await removeProduct(p) }
        q.push(function () { app.appendChild(card) })
      })
    }

    const foot = document.createElement('div'); foot.className = 'text-center'; foot.style.cssText = 'padding:16px;color:var(--sub);font-size:13px'
    foot.textContent = '点商品可去开单页卖它；删除只能删没入过库、没流水的新建错档（有历史的可改停产）'
    q.push(function () { app.appendChild(foot) })
    drain()
  }

  render()
  search('')
})
