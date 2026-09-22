// ai.js: AI 助手 —— 问库存 / 要补货建议 / 经营问题，手机端也能用"小渔"
//
// 2026-09-21：以前这里的失败提示只有一句「小渔没回答上，换个问法试试」——
// 真相是服务端压根没接通 AI（中心库没注入 ai 模块），用户被这句话误导了一路。
// 现在：①页头先把 AI 状态写清楚（通没通、用量还剩多少）②失败按真实原因说人话，
//       ③设备身份过期自动重注册后重试一次，④原始 reason 用小字附上，方便报障时定位。
page('ai', function (app) {
  let messages = [] // {role:'user'|'assistant', content}
  let busy = false
  let aiStatus = null      // {configured, provider, model}
  let remaining = null     // 本月剩余 token（网关回的）

  // 失败原因 → 老板看得懂的话（真实原因，不糊弄）
  const REASONS = {
    'quota-exceeded': '这个月的 AI 免费用量用完了（每月 1 号自动恢复）。想马上继续用：电脑端「设置 → AI 助手」填自己的 Key，自备 Key 不限次。',
    'no-key': '电脑上还没配置 AI 助手（设置 → AI 助手 填 API Key）。',
    'ai-not-ready': '服务器上的 AI 还没接好，让维护看一下中心库服务。',
    'invalid-device': '设备身份刚过期，已自动重新注册，请再问一遍。',
    timeout: 'AI 服务响应超时（网络慢），再问一遍试试。',
    network: '连不上 AI 服务，检查手机网络后重试。',
    'register-failed': '连不上官方 AI 服务（设备注册失败），检查网络或稍后再试。',
    'upstream-error': 'AI 服务临时出错，稍后再试。',
    'too-many-rounds': '这个问题要查好几轮，换个更具体的问法。',
    empty: '小渔没答上来，换个问法试试。',
  }
  const reasonText = (r) => REASONS[r && r.reason] || ('小渔没答上来（' + ((r && r.reason) || '未知原因') + '）')

  function render() {
    app.innerHTML = ''

    // 顶部：小渔 + 真实状态
    const head = document.createElement('div'); head.style.cssText = 'padding:14px 16px 4px'
    const off = aiStatus && aiStatus.configured === false
    const statusLine = off
      ? '<div style="margin-top:8px;font-size:12px;color:var(--red);font-weight:700;display:flex;align-items:center;gap:5px">' + FiIcon('alert', 13) + '还没接通 AI —— 去电脑上「设置 → AI 助手」配一下，或者找维护看中心库服务</div>'
      : '<div style="margin-top:8px;font-size:12px;color:var(--sub)">' +
          (aiStatus ? ('已接通 · ' + (aiStatus.provider || 'AI') + (aiStatus.model ? '（' + aiStatus.model + '）' : '')) : '正在检查 AI 状态…') +
          (remaining == null ? '' : ' · 本月免费用量还剩约 ' + Math.round(remaining / 1000) + 'k token') +
        '</div>'
    head.innerHTML =
      '<div class="card" style="border:1px solid var(--line);background:var(--card);margin:0;padding:14px">' +
        '<div class="flex" style="align-items:center;gap:8px">' +
          '<div style="width:40px;height:40px;border-radius:13px;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center">' + FiIcon('sparkle', 20) + '</div>' +
          '<div><div class="font-bold">小渔 · AI 助手</div><div class="text-xs" style="color:var(--sub)">问库存、要补货建议、看经营问题</div></div>' +
        '</div>' +
        statusLine +
        '<div style="margin-top:8px;font-size:12px;color:var(--sub)">例如：什么快卖完了？该补哪些货？这个月赚多少？</div>' +
      '</div>'
    app.appendChild(head)

    // 对话区
    const chatBox = document.createElement('div'); chatBox.style.cssText = 'padding:12px 16px;max-height:52vh;overflow-y:auto'
    if (messages.length === 0) {
      chatBox.innerHTML = '<div class="text-center text-muted" style="padding:24px;font-size:13px">打一句话问问小渔</div>'
    } else {
      messages.forEach(m => {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;' + (m.role === 'user' ? 'justify-content:flex-end' : 'justify-content:flex-start') + ';margin-bottom:10px'
        const bubble = document.createElement('div')
        bubble.style.cssText = 'max-width:80%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;' +
          (m.role === 'user'
            ? 'background:var(--ink);color:var(--paper);border-bottom-right-radius:4px'
            : 'background:var(--card);border:2px solid var(--ink);border-bottom-left-radius:4px')
        bubble.textContent = m.content
        row.appendChild(bubble)
        chatBox.appendChild(row)
      })
      if (busy) {
        const wait = document.createElement('div')
        wait.style.cssText = 'font-size:12px;color:var(--sub);padding:2px 4px 8px'
        wait.textContent = '小渔正在想…'
        chatBox.appendChild(wait)
      }
    }
    app.appendChild(chatBox)

    // 快捷问题
    const quick = document.createElement('div'); quick.style.cssText = 'display:flex;gap:8px;padding:0 16px 10px;overflow-x:auto;flex-wrap:wrap'
    ;['哪些货该补了', '什么卖得最好', '有没有滞销品', '这个月赚多少'].forEach(q => {
      const t = document.createElement('span'); t.className = 'tag'; t.textContent = q
      t.onclick = () => send(q)
      quick.appendChild(t)
    })
    app.appendChild(quick)

    // 客服三层的第一层到第二层的桥（2026-09-21）：
    // 小渔答不上 → 一键反馈给开发 → 回复能在「我的反馈」里看到。
    // 没有这一条，「AI 客服」在用户眼里就是个答不上来还堵死路的哑助手。
    const helpRow = document.createElement('div')
    helpRow.style.cssText = 'padding:0 16px 10px'
    helpRow.innerHTML = '<button id="ai-human" style="width:100%;height:40px;border-radius:10px;border:1px dashed var(--line);background:transparent;color:var(--sub);font-size:13px;font-weight:700">小渔答不上来？直接告诉我们（会有人看）</button>'
    app.appendChild(helpRow)
    helpRow.querySelector('#ai-human').onclick = function () { openFeedbackSheet() }

    // 输入区
    const inputRow = document.createElement('div'); inputRow.style.cssText = 'display:flex;gap:10px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));position:sticky;bottom:0;background:var(--paper)'
    const inp = document.createElement('input'); inp.id = 'ai-input'; inp.className = 'search'; inp.style.flex = '1'; inp.placeholder = '问小渔...'
    inp.style.height = '48px'
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(inp.value) })
    const btn = document.createElement('button'); btn.id = 'ai-send'; btn.textContent = '发送'
    btn.style.cssText = 'height:48px;padding:0 18px;border-radius:12px;border:none;background:var(--gold);color:#fff;font-size:15px;font-weight:800'
    btn.onclick = () => send(document.getElementById('ai-input')?.value || '')
    inputRow.appendChild(inp); inputRow.appendChild(btn)
    app.appendChild(inputRow)

    chatBox.scrollTop = chatBox.scrollHeight
    setTimeout(() => { const i = document.getElementById('ai-input'); if (i) i.focus() }, 100)
  }

  // 真问一次；invalid-device 说明设备令牌失效（网关重置/换机）→ 重注册后重试一次
  async function ask(msgs, retried) {
    let r
    try { r = await api('ai:chat', { messages: msgs }) } catch (e) { r = { ok: false, reason: 'network', detail: e && e.message } }
    if (r && r.ok && r.content) return r
    if (r && r.reason === 'invalid-device' && !retried) {
      await new Promise((res) => setTimeout(res, 300))
      return ask(msgs, true)
    }
    return r || { ok: false, reason: 'unknown' }
  }

  async function send(text) {
    const msg = (text || '').trim()
    if (!msg || busy) return
    const input = document.getElementById('ai-input')
    if (input) input.value = ''
    messages.push({ role: 'user', content: msg })
    busy = true
    render()
    try {
      const r = await ask(messages.slice(-8).map(m => ({ role: m.role, content: m.content })), false)
      if (r.ok && r.content) {
        if (typeof r.remaining === 'number') remaining = r.remaining
        messages.push({ role: 'assistant', content: r.content })
      } else {
        const hint = reasonText(r)
        messages.push({ role: 'assistant', content: hint + '\n\n（原因代码：' + (r.reason || 'unknown') + '）' })
      }
    } finally { busy = false; render() }
  }

  render()
  // 页头状态：先把「通没通」查清楚，别让用户对着一个哑助手乱猜
  api('ai:status').then(s => { aiStatus = s || null; render() }).catch(() => { render() })
})
