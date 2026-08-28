// ai.js: AI 助手 —— 问库存/补货建议/经营问题，手机端也能用"小渔"
page('ai', function (app) {
  let messages = [] // {role:'user'|'assistant', content}
  let busy = false

  function render() {
    app.innerHTML = ''

    // 顶部 AI 状态
    const head = document.createElement('div'); head.style.cssText = 'padding:16px 16px 4px'
    head.innerHTML =
      '<div class="card" style="border:2px solid var(--gold);background:linear-gradient(135deg,#fffdf7,#faf3e3);margin:0;padding:14px">' +
        '<div class="flex" style="align-items:center;gap:8px">' +
          '<div style="width:40px;height:40px;border-radius:50%;background:var(--gold);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900">渔</div>' +
          '<div><div class="font-bold">小渔 · AI 助手</div><div class="text-xs" style="color:var(--sub)">问库存、要补货建议、看经营问题</div></div>' +
        '</div>' +
        '<div style="margin-top:8px;font-size:12px;color:var(--sub)">例如：什么快卖完了？该补哪些货？这个月赚多少？</div>' +
      '</div>'
    app.appendChild(head)

    // 对话区
    const chatBox = document.createElement('div'); chatBox.style.cssText = 'padding:12px 16px;max-height:52vh;overflow-y:auto'
    if (messages.length === 0) {
      chatBox.innerHTML = '<div class="text-center text-muted" style="padding:24px;font-size:13px">打一句话问问小渔 👇</div>'
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
    }
    app.appendChild(chatBox)

    // 快捷问题
    const quick = document.createElement('div'); quick.style.cssText = 'display:flex;gap:8px;padding:0 16px 10px;overflow-x:auto;flex-wrap:wrap'
    ;['哪些货该补了', '什么卖得最好', '有没有滞销品'].forEach(q => {
      const t = document.createElement('span'); t.className = 'tag'; t.textContent = q
      t.onclick = () => send(q)
      quick.appendChild(t)
    })
    app.appendChild(quick)

    // 输入区
    const inputRow = document.createElement('div'); inputRow.style.cssText = 'display:flex;gap:10px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));position:sticky;bottom:0;background:var(--paper)'
    const inp = document.createElement('input'); inp.id = 'ai-input'; inp.className = 'search'; inp.style.flex = '1'; inp.placeholder = '问小渔...'
    inp.style.height = '52px'
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(inp.value) })
    const btn = document.createElement('button'); btn.id = 'ai-send'; btn.textContent = '发送'
    btn.style.cssText = 'height:52px;padding:0 18px;border-radius:12px;border:none;background:var(--gold);color:#fff;font-size:16px;font-weight:800'
    btn.onclick = () => send(document.getElementById('ai-input')?.value || '')
    inputRow.appendChild(inp); inputRow.appendChild(btn)
    app.appendChild(inputRow)

    // 滚动到底部
    chatBox.scrollTop = chatBox.scrollHeight
    setTimeout(() => { const i = document.getElementById('ai-input'); if (i) i.focus() }, 100)
  }

  async function send(text) {
    const msg = (text || '').trim()
    if (!msg || busy) return
    const input = document.getElementById('ai-input')
    if (input) input.value = ''
    messages.push({ role: 'user', content: msg })
    render()
    busy = true
    try {
      const r = await api('ai:chat', { messages: messages.slice(-8) }) // 只带最近8条防超长
      if (r?.ok && r.content) {
        messages.push({ role: 'assistant', content: r.content })
      } else {
        messages.push({ role: 'assistant', content: r?.reason === 'no-key' ? '电脑上还没配置 AI 助手（设置页填 API Key）' : '小渔没回答上，换个问法试试' })
      }
    } catch (e) {
      messages.push({ role: 'assistant', content: '连接失败：' + (e.message || '') })
    } finally { busy = false; render() }
  }

  render()
})
