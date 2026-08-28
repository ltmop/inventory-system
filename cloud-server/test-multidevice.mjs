const base = 'http://127.0.0.1:3199'
async function api(path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
  return res.json()
}
let pass = 0, fail = 0
const ok = (c, n, x='') => { if (c) { pass++; console.log('  ✓ ' + n + (x ? ' [' + x + ']' : '')) } else { fail++; console.log('  ✗ ' + n + (x ? ' [' + x + ']' : '')) } }

// 1. 注册
const r1 = await api('/api/account/register', { username: 'duo-device', password: '123456', note: '多设备测试' })
ok(r1.ok && !!r1.userId, '注册账户')
const userId = r1.userId

// 2. 设备A绑定
const bA = await api('/api/device/bind', { username: 'duo-device', password: '123456', deviceName: '门店电脑A' })
ok(bA.ok && !!bA.uploadToken, '设备A绑定')
const tokenA = bA.uploadToken

// 3. 设备B绑定（同一账户第二台）
const bB = await api('/api/device/bind', { username: 'duo-device', password: '123456', deviceName: '门店电脑B' })
ok(bB.ok && bB.uploadToken !== tokenA, '设备B绑定（独立 token）')
const tokenB = bB.uploadToken

// 4. A 上传快照
const sA = await api('/api/snapshot', { iv: 'a'.repeat(16), data: 'SNAP-A' }, { 'x-token': tokenA })
ok(sA.ok, '设备A上传快照')

// 5. B 上传快照（同一账户共享数据）
const sB = await api('/api/snapshot', { iv: 'b'.repeat(16), data: 'SNAP-B' }, { 'x-token': tokenB })
ok(sB.ok, '设备B上传快照')

// 6. A 上传备份
const bk = await api('/api/backup', { iv: 'c'.repeat(16), data: 'BACKUP' }, { 'x-token': tokenA, 'x-date': '2026-08-21' })
ok(bk.ok, '设备A上传备份')

// 7. B 能看 A 的备份（数据共享）
const list = await fetch(base + '/api/backup/list', { headers: { 'x-token': tokenB } }).then(r => r.json())
ok(list.ok && list.files.some(f => f.date === '2026-08-21'), '设备B可见A的备份')

// 8. 远程看店 viewToken（B 的 viewToken 也能打开）
const bB2 = bB
const viewOk = await fetch(base + '/v/' + bB2.viewToken).then(r => r.status)
ok(viewOk === 200, '设备B viewToken 可打开看店页', 'status=' + viewOk)

// 9. A 吊销后 B 仍可用（A 的 viewToken 失效，B 不受影响）
console.log('\n==== 多设备测试: ' + pass + ' 通过, ' + fail + ' 失败 ====')
process.exit(fail > 0 ? 1 : 0)
