// cloud-server 完整链路测试
const base = 'http://127.0.0.1:3199'
async function api(path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

let pass = 0, fail = 0
const ok = (c, n, x='') => { if (c) { pass++; console.log('  ✓ ' + n + (x ? ' [' + x + ']' : '')) } else { fail++; console.log('  ✗ ' + n + (x ? ' [' + x + ']' : '')) } }

// 1. 注册账户
const r1 = await api('/api/account/register', { username: 'laoban2', password: '123456', note: '总店' })
ok(r1.ok && !!r1.userId, '注册账户', r1.userId?.slice(0, 8))
const userId = r1.userId

// 2. 重复注册应报错
const r1b = await api('/api/account/register', { username: 'laoban2', password: '123456' })
ok(!r1b.ok, '重复注册被拒绝', r1b.error)

// 3. 登录
const r2 = await api('/api/account/login', { username: 'laoban2', password: '123456' })
ok(r2.ok && r2.userId === userId, '登录成功')

// 4. 错误密码
const r2b = await api('/api/account/login', { username: 'laoban2', password: 'wrong' })
ok(!r2b.ok, '错误密码被拒')

// 5. 设备绑定（电脑A）
const r3 = await api('/api/device/bind', { username: 'laoban2', password: '123456', deviceName: '电脑A' })
ok(r3.ok && r3.uploadToken, '设备A绑定')
const tokenA = r3.uploadToken

// 6. 设备B再绑定（同一账户第二台电脑）
const r4 = await api('/api/device/bind', { username: 'laoban2', password: '123456', deviceName: '电脑B' })
ok(r4.ok && r4.uploadToken && r4.uploadToken !== tokenA, '设备B绑定（多设备）')
const tokenB = r4.uploadToken

// 7. 设备A上传快照（用 A 的 token）
const snapA = await api('/api/snapshot', { iv: 'a'.repeat(16), data: 'ENCRYPTED-SNAP-A' }, { 'x-user-id': userId, 'x-token': tokenA })
ok(snapA.ok, '设备A上传快照')

// 8. 设备B上传快照（用 B 的 token，同一账户共享）
const snapB = await api('/api/snapshot', { iv: 'b'.repeat(16), data: 'ENCRYPTED-SNAP-B' }, { 'x-user-id': userId, 'x-token': tokenB })
ok(snapB.ok, '设备B上传快照（同一账户）')

// 9. 设备A上传备份
const backup = await api('/api/backup', { iv: 'c'.repeat(16), data: 'ENCRYPTED-BACKUP' }, { 'x-user-id': userId, 'x-token': tokenA, 'x-date': '2026-08-20' })
ok(backup.ok, '设备A上传备份')

// 10. 设备B列备份（共享同一账户数据）
const list = await fetch(base + '/api/backup/list', { headers: { 'x-user-id': userId, 'x-token': tokenB } }).then(r => r.json())
ok(list.ok && list.files.some(f => f.date === '2026-08-20'), '设备B能看到A的备份（数据共享）')

// 11. 过期/无效 token 拒绝
const bad = await fetch(base + '/api/backup/list', { headers: { 'x-user-id': userId, 'x-token': 'bad-token' } }).then(r => r.json())
ok(!bad.ok, '无效token被拒')

console.log('\n==== cloud-server 测试: ' + pass + ' 通过, ' + fail + ' 失败 ====')
process.exit(fail > 0 ? 1 : 0)
