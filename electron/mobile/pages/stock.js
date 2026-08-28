// stock.js: 库存查询 —— 打开直接显示全部 SKU，按货位/品类分组，大字卡片（40岁+友好）
page('stock', function (app) {
  let keyword = '', results = [], tmr = null

  async function search(kw) {
    keyword = kw
    clearTimeout(tmr)
    tmr = setTimeout(async () => {
      try { results = await api('product:list', { keyword: kw, limit: 500 }) } catch { results = [] }
      render()
    }, 250)
  }

  // 切换热销/处理货标记，成功后刷新列表
  async function toggleMark(id, field, value) {
    try {
      await api('product:mark', { id, [field]: value ? 1 : 0, operator: '手机' })
      await search(keyword)
    } catch (e) { toast('标记失败: ' + (e.message || '')) }
  }

  function render() {
    app.innerHTML = ''

    // 搜索框 + 语音
    const sr = document.createElement('div'); sr.className = 'scanrow'
    const inp = document.createElement('input'); inp.className = 'search'; inp.placeholder = '🔍 输入品名/条码/SKU 过滤...'; inp.value = keyword; inp.style.width = '100%'
    inp.oninput = (e) => search(e.target.value.trim())
    const mic = document.createElement('button'); mic.className = 'scanbtn'; mic.style.flex = '0 0 56px'; mic.style.height = '60px'
    mic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="26" height="26"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM5 10a7 7 0 0 0 14 0M12 17v4"/></svg>'
    mic.onclick = () => voiceInput((text) => { if (text) { smartVoiceSearch(text, (t) => { if (t) { inp.value = t; search(t) } }) } }, '说商品名查库存')
    sr.appendChild(inp); sr.appendChild(mic); app.appendChild(sr)

    // 扫码查库存
    const btn = document.createElement('button'); btn.className = 'scanbtn'; btn.style.margin = '10px 16px'; btn.style.width = 'calc(100% - 32px)'
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M4 12h16"/></svg>扫码查库存'
    btn.onclick = () => openScanner((code) => { if (code) { inp.value = code; search(code) } }, '扫码查库存')
    app.appendChild(btn)

    if (results.length === 0) {
      const empty = document.createElement('div'); empty.className = 'text-center text-muted'; empty.style.padding = '30px'; empty.style.fontSize = '15px'
      empty.textContent = keyword ? '没有找到「' + keyword + '」' : '加载中...'
      app.appendChild(empty)
      return
    }

    // 顶部统计（大字）
    const totalCount = results.length
    const lowCount = results.filter(p => (p.total_stock || 0) < (p.min_stock || 5)).length
    const stat = document.createElement('div'); stat.style.cssText = 'padding:8px 18px 12px;font-size:15px;font-weight:700'
    stat.textContent = '共 ' + totalCount + ' 个SKU' + (lowCount > 0 ? ' · 🔴 低库存 ' + lowCount + ' 个' : ' · 库存都充足')
    app.appendChild(stat)

    // 低库存置顶
    const sorted = [...results].sort((a, b) => {
      const aLow = (a.total_stock || 0) < (a.min_stock || 5) ? 1 : 0
      const bLow = (b.total_stock || 0) < (b.min_stock || 5) ? 1 : 0
      if (aLow !== bLow) return bLow - aLow
      return (a.category || '').localeCompare(b.category || '')
    })

    // 按货位分组（有 location 的优先），没货位的归到品类组
    const groups = {} // key: 组名
    sorted.forEach(p => {
      const loc = (p.location || '').trim()
      const key = loc || (p.category || '其他')
      ;(groups[key] = groups[key] || []).push(p)
    })

    for (const grpKey of Object.keys(groups)) {
      // 货位组名用"📍 货位"，品类组名用品类
      const isLoc = groups[grpKey].every(p => (p.location || '').trim() === grpKey) && grpKey.trim()
      const title = document.createElement('div'); title.className = 'sectitle'
      title.innerHTML = '<span class="tag" style="font-size:14px">' + (isLoc ? '📍 ' : '') + grpKey + '</span><span style="font-size:13px">' + groups[grpKey].length + ' 个</span>'
      app.appendChild(title)

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
          '</div>'
        // 点卡片主体去开单页卖它；点标记按钮切换热销/处理货
        card.onclick = () => { try { localStorage.setItem('fi-pos-preselect', String(p.id)) } catch {} navigate('pos') }
        const hotBtn = card.querySelector('[data-hot]')
        const clearBtn = card.querySelector('[data-clear]')
        if (hotBtn) hotBtn.onclick = async (e) => { e.stopPropagation(); await toggleMark(p.id, 'is_hot', !isHot) }
        if (clearBtn) clearBtn.onclick = async (e) => { e.stopPropagation(); await toggleMark(p.id, 'is_clearance', !isClear) }
        app.appendChild(card)
      })
    }

    // 底部提示
    const foot = document.createElement('div'); foot.className = 'text-center'; foot.style.cssText = 'padding:16px;color:var(--sub);font-size:13px'
    foot.textContent = '点商品可去开单页卖它'
    app.appendChild(foot)
  }

  render()
  // 首屏默认拉全部
  search('')
})
