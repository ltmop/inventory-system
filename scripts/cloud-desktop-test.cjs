const { _electron: electron } = require('playwright')
;(async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.waitForLoadState('load')
  await win.waitForTimeout(3500)
  // 测 cloud:registerAccount（公网）
  const uname = '桌面端' + Date.now().toString().slice(-5)
  const reg = await win.evaluate(async (u) => {
    const r = await window.fi.invoke('cloud:registerAccount', { username: u, password: 'test123456' })
    return r
  }, uname)
  console.log('桌面端注册(公网):', JSON.stringify(reg))
  // 测登录绑定
  const login = await win.evaluate(async (u) => {
    const r = await window.fi.invoke('cloud:loginAccount', { username: u, password: 'test123456', deviceName: '桌面端测试' })
    return r
  }, uname)
  console.log('桌面端登录绑定:', JSON.stringify(login).slice(0, 150))
  await app.close()
  console.log('\n桌面端公网云同步验证完成')
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
