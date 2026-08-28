// Electron 实跑验证（手机看店链路只读版）：启动应用 → server:status 应运行中 →
// Node 侧真实 fetch 手机 URL（带 token 200 / 不带 401）→ 开关往返 → 恢复开启。
// 不写任何业务数据；结束时确保服务保持开启（生产默认状态）。
const { _electron: electron } = require('playwright')

;(async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.waitForLoadState('load')
  await win.waitForTimeout(2500)

  const hasFi = await win.evaluate(() => typeof window.fi !== 'undefined')
  if (!hasFi) throw new Error('preload 未注入 window.fi')

  // 服务应在主进程 app ready 后自动启动
  const st = await win.evaluate(() => window.fi.invoke('server:status'))
  console.log('server:status →', JSON.stringify({ ...st, url: st.url ? '(含 token)' : null }))
  if (!st.running || !st.url) throw new Error('手机看店服务未随应用启动')

  // 真实 HTTP：带 token 200，不带 401
  const rOk = await fetch(st.url)
  const html = await rOk.text()
  console.log('GET / →', rOk.status, html.includes('手机看店') ? '页面标题正确' : '页面异常')
  if (rOk.status !== 200 || !html.includes('手机看店')) throw new Error('手机页面访问失败')
  const rApi = await fetch(st.url.replace('/?token=', '/api/summary?token='))
  const sum = await rApi.json()
  console.log('GET /api/summary →', rApi.status, '今日营业额(分):', sum.todayRevenue, '总SKU:', sum.totalSku)
  if (rApi.status !== 200 || typeof sum.todayRevenue !== 'number') throw new Error('summary API 异常')
  const r401 = await fetch(st.url.replace(/\/\?token=.*/, '/api/summary'))
  if (r401.status !== 401) throw new Error('无 token 未拦截（应为 401）')
  console.log('无 token → 401 正确')

  // 开关往返：关 → 关后应立即连不上；开 → 恢复
  const off = await win.evaluate(() => window.fi.invoke('server:toggle', { enabled: false }))
  if (off.running !== false) throw new Error('关闭后仍在运行')
  let refused = false
  try { await fetch(st.url) } catch { refused = true }
  if (!refused) throw new Error('关闭后端口仍可访问')
  const on = await win.evaluate(() => window.fi.invoke('server:toggle', { enabled: true }))
  if (!on.running || !on.url) throw new Error('重新开启失败')
  const rBack = await fetch(on.url)
  if (rBack.status !== 200) throw new Error('重新开启后页面访问失败')
  console.log('开关往返正常，服务已恢复开启')

  await app.close()
  console.log('\nElectron 手机看店链路端到端验证全部通过')
  process.exit(0)
})().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
