/**
 * 双机对同步验证（阶段 2.2）
 * 起真实 cloud-server，用两份真实库副本当作 A / B 两台机器，验证：
 *   A 推  B 拉 / 冲突不静默覆盖 / 删除墓碑 / 悬空外键回填
 * 用法：node scripts/test-sync-engine.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCloudSync } from '../electron/cloudSync.js'

const SERVER_DIR = process.env.CLOUD_SERVER_DIR || 'D:/通用进销存/cloud-server'
const PORT = 39701
const BASE = `http://127.0.0.1:${PORT}`
const ADMIN_KEY = 'test-admin-key-0123456789'
const REAL_DB = path.join(process.env.APPDATA, 'fishing-inventory', 'data.db')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; failures.push(name + (extra ? '  [' + extra + ']' : '')); console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}
// 测试用编解码：只验管线，真实加密由 cloud.js 注入
const enc = (s) => ({ iv: 'iv', data: Buffer.from(s, 'utf8').toString('base64') })
const dec = ({ data }) => Buffer.from(data, 'base64').toString('utf8')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-e2e-'))
const dataRoot = path.join(tmpDir, 'cloud')
fs.mkdirSync(dataRoot, { recursive: true })

console.log('起真实 cloud-server（cwd=' + SERVER_DIR + '，端口 ' + PORT + '）')
const srv = spawn(process.execPath, ['index.js'], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), CLOUD_DATA_ROOT: dataRoot, ADMIN_KEY, COCKPIT_SMS_MOCK: '1', NODE_ENV: 'test', TRUST_PROXY: '1' },
  windowsHide: true,
})
let srvOut = ''
srv.stdout.on('data', (d) => { srvOut += d.toString() })
srv.stderr.on('data', (d) => { srvOut += d.toString() })

async function jpost(p, body, headers = {}) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

try {
  let ready = false
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/account/captcha'); if (r.status === 200) { ready = true; break } } catch {} await sleep(100) }
  if (!ready) throw new Error('服务端未就绪:\n' + srvOut)

  // 造一个进销存账号 + 设备令牌
  const reg = await jpost('/api/account/register', { username: 'e2e', password: 'pass123456' }, { 'x-admin-key': ADMIN_KEY })
  const bind = await jpost('/api/device/bind', { username: 'e2e', password: 'pass123456', deviceName: 'dev' })
  const auth = { userId: reg.body.userId, uploadToken: bind.body.uploadToken }
  console.log('账号 userId=' + auth.userId + '，设备令牌长度=' + (auth.uploadToken || '').length + '\n')

  // 两份真实库副本 = A / B 两台机器
  const A = path.join(tmpDir, 'A.db'), B = path.join(tmpDir, 'B.db')
  fs.copyFileSync(REAL_DB, A); fs.copyFileSync(REAL_DB, B)
  const dbA = new DatabaseSync(A), dbB = new DatabaseSync(B)
  const mk = (db) => createCloudSync({ db, encrypt: enc, decrypt: dec, getAuth: () => auth, cloudUrl: BASE, log: () => {} })
  const sA = mk(dbA), sB = mk(dbB)

  console.log('[1] A 新增一个商品  推  B 拉')
  const pname = '__e2e_prod__' + Date.now()
  dbA.prepare('INSERT INTO products (sku_code, category, cost_price, name_vi) VALUES (?,?,?,?)').run(pname, '其他', 111, pname)
  const prod = dbA.prepare('SELECT id, guid FROM products WHERE sku_code = ?').get(pname)
  const parRec0 = sA.buildRecord('products', prod.guid)
  ok('A 新行 guid 被触发器自动填充', !!prod && /^[0-9a-f]{32}$/.test(prod.guid), JSON.stringify(prod))
  const r1 = await sA.push()
  ok('A 推送成功（含 1 条）', r1.pushed >= 1 && (r1.conflicts || []).length === 0, JSON.stringify(r1))
  const r1b = await sB.pull()
  const gotB = dbB.prepare('SELECT id, guid, sku_code, cost_price FROM products WHERE guid = ?').get(prod.guid)
  ok('B 拉到该商品（guid 一致，本地 id 各自不同）', !!gotB && gotB.sku_code === pname && gotB.cost_price === 111, JSON.stringify(gotB))
  ok('载荷里不含本地整数 id（不外传）', !Object.prototype.hasOwnProperty.call(parRec0.row, 'id'), JSON.stringify(Object.keys(parRec0.row)))

  console.log('\n[2] 冲突：A、B 各改同一商品，A 先推、B 后推（带着更旧的时间戳）')
  dbA.prepare('UPDATE products SET cost_price = 333 WHERE guid = ?').run(prod.guid)
  await sleep(20)
  dbB.prepare('UPDATE products SET cost_price = 444 WHERE guid = ?').run(prod.guid)
  const ra = await sA.push()
  await sleep(20)
  // 人为把 B 的待推时间戳改旧，模拟"B 落后"
  dbB.prepare('UPDATE sync_changelog SET at = ? WHERE guid = ?').run('2000-01-01T00:00:00.000Z', prod.guid)
  const rb = await sB.push()
  ok('B 的过时版本被判为冲突（服务端不覆盖）', (rb.conflicts || []).length === 1, JSON.stringify(rb.conflicts))
  ok('冲突里带着服务端版本供呈现', !!(rb.conflicts[0] && rb.conflicts[0].server), JSON.stringify(rb.conflicts[0] || null))
  const srvVal = dbB.prepare('SELECT cost_price FROM products WHERE guid = ?').get(prod.guid)
  ok('B 本地未被静默改写（还是 444，等用户决定）', srvVal.cost_price === 444, JSON.stringify(srvVal))

  console.log('\n[3] 删除：A 删  墓碑传播  B 也删')
  dbA.prepare('DELETE FROM products WHERE guid = ?').run(prod.guid)
  await sA.push()
  await sB.pull()
  const gone = dbB.prepare('SELECT id FROM products WHERE guid = ?').get(prod.guid)
  ok('B 本地该商品已被删除', !gone, JSON.stringify(gone))

  console.log('\n[4] 悬空外键：子记录先到（父还没到） 之后父到了要自动回填')
  // A 造一个商品 + 一个批次
  const p2 = '__e2e_parent__' + Date.now()
  dbA.prepare('INSERT INTO products (sku_code, category, cost_price) VALUES (?,?,?)').run(p2, '其他', 1)
  const par = dbA.prepare('SELECT id, guid FROM products WHERE sku_code = ?').get(p2)
  dbA.prepare('INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, inbound_date) VALUES (?,?,?,?,?)').run(par.id, 'B-E2E', 10, 5, '2026-09-12')
  const bat = dbA.prepare('SELECT id, guid FROM inventory_batches WHERE batch_no = ?').get('B-E2E')
  const parRec = sA.buildRecord('products', par.guid)
  const batRec = sA.buildRecord('inventory_batches', bat.guid)
  ok('载荷里外键是 guid 而不是本地 id', !!(batRec.refs && batRec.refs.product_id === par.guid), JSON.stringify(batRec.refs))
  // 故意只把子记录（批次）应用给 B
  sB.applyChanges([{ kind: 'inventory_batch', id: bat.guid, updatedAt: '2026-09-12T14:00:00Z', iv: enc(JSON.stringify(batRec)).iv, data: enc(JSON.stringify(batRec)).data }])
  const batB1 = dbB.prepare('SELECT id, product_id FROM inventory_batches WHERE guid = ?').get(bat.guid)
  ok('父未到时不硬插（NOT NULL 外键不会崩）', !batB1, JSON.stringify(batB1))
  const defB = dbB.prepare('SELECT COUNT(*) n FROM sync_pending_record').get().n
  ok('该条进了延后队列等父记录', defB >= 1, 'deferred=' + defB)
  // 父记录到达
  sB.applyChanges([{ kind: 'product', id: par.guid, updatedAt: '2026-09-12T14:00:01Z', iv: enc(JSON.stringify(parRec)).iv, data: enc(JSON.stringify(parRec)).data }])
  const batB2 = dbB.prepare('SELECT b.product_id, p.guid AS pguid FROM inventory_batches b LEFT JOIN products p ON p.id = b.product_id WHERE b.guid = ?').get(bat.guid)
  ok('父记录到达后外键自动回填到本地 id', !!batB2 && batB2.product_id !== null && batB2.pguid === par.guid, JSON.stringify(batB2))
  const pend2 = dbB.prepare('SELECT COUNT(*) n FROM sync_pending_ref').get().n
  ok('待回填清单已清空（该条）', pend2 === 0 || pend2 < pend, 'pending=' + pend2)

  console.log('\n[5] 防回声：B 拉完之后，B 自己的 changelog 不应堆积')
  const statusB = sB.status()
  ok('B 无待推积压（应用远端不产生自产日志）', statusB.backlog === 0, JSON.stringify(statusB))


  console.log('\n[6] 2.3 冲突逐条处理（保留我的 / 用云端的）')
  const p3 = '__e2e_conflict__' + Date.now()
  dbA.prepare('INSERT INTO products (sku_code, category, cost_price) VALUES (?,?,?)').run(p3, '其他', 1000)
  const pr3 = dbA.prepare('SELECT id, guid FROM products WHERE sku_code = ?').get(p3)
  await sA.push(); await sB.pull()
  ok('两边都有了这条记录', !!dbB.prepare('SELECT id FROM products WHERE guid = ?').get(pr3.guid), '')
  // A、B 各改一次，A 先推
  dbA.prepare('UPDATE products SET cost_price = 1001 WHERE guid = ?').run(pr3.guid)
  await sleep(20)
  dbB.prepare('UPDATE products SET cost_price = 2002 WHERE guid = ?').run(pr3.guid)
  await sA.push()
  dbB.prepare('UPDATE sync_changelog SET at = ? WHERE guid = ?').run('2000-01-01T00:00:00.000Z', pr3.guid)
  await sB.push()
  ok('冲突被记录到待处理列表', sB.listConflicts().some((c) => c.id === pr3.guid), JSON.stringify(sB.listConflicts()))
  // 选择：保留我的
  let rf = sB.resolveConflict('product', pr3.guid, 'mine')
  ok('选「保留我的」被接受', rf.ok === true, JSON.stringify(rf))
  await sB.push()
  await sA.pull()
  ok('云端已变成本机版本（A 拉到 2002）', dbA.prepare('SELECT cost_price FROM products WHERE guid = ?').get(pr3.guid).cost_price === 2002, JSON.stringify(dbA.prepare('SELECT cost_price FROM products WHERE guid = ?').get(pr3.guid)))
  ok('该冲突已从待处理列表移除', !sB.listConflicts().some((c) => c.id === pr3.guid), JSON.stringify(sB.listConflicts()))
  // 再制造一次冲突，这次选「用云端的」
  dbA.prepare('UPDATE products SET cost_price = 3003 WHERE guid = ?').run(pr3.guid)
  await sA.push()
  dbB.prepare('UPDATE products SET cost_price = 4004 WHERE guid = ?').run(pr3.guid)
  dbB.prepare('UPDATE sync_changelog SET at = ? WHERE guid = ?').run('2000-01-01T00:00:00.000Z', pr3.guid)
  await sB.push()
  ok('再次产生冲突', sB.listConflicts().some((c) => c.id === pr3.guid), JSON.stringify(sB.listConflicts()))
  rf = sB.resolveConflict('product', pr3.guid, 'theirs')
  ok('选「用云端的」被接受', rf.ok === true, JSON.stringify(rf))
  ok('本机已采用云端版本（3003）', dbB.prepare('SELECT cost_price FROM products WHERE guid = ?').get(pr3.guid).cost_price === 3003, JSON.stringify(dbB.prepare('SELECT cost_price FROM products WHERE guid = ?').get(pr3.guid)))
  ok('非法 choice 被拒', sB.resolveConflict('product', pr3.guid, 'whatever').ok === false, '')

  dbA.close(); dbB.close()
} catch (e) {
  fail++; failures.push('异常: ' + e.message)
  console.error('\n异常: ' + e.message)
} finally {
  try { srv.kill() } catch {}
  await sleep(300)
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
}

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
if (fail) console.log('未通过:\n - ' + failures.join('\n - '))
console.log('======================================')
process.exit(fail ? 1 : 0)