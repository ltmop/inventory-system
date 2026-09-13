// 搬运脚本（scripts/server/backfill-central-from-local.mjs）的常驻护栏测试。
//
// 为什么值得单独一个套件：这个脚本是往**生产中央库**写业务数据的工具，
// 它最危险的失败模式不是报错，而是**静默覆盖门店的账**（同 id 但内容不同）。
// 所以这里逐条验：分类对不对、冲突到底有没有被保住、能不能重跑、备份是否可信。
//
// 自包含：两个库都用应用自己的 openDatabase() 建，不依赖任何本机真实数据。
// 真实中央库副本上的验证另做过一次（含 guid 不对称：中央库没有 guid 列），结论一致。
//
// 跑法：node scripts/test-backfill-central.mjs
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../electron/db.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'server', 'backfill-central-from-local.mjs')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-test-'))
const SHOP = path.join(work, 'shop.db')
const TARGET = path.join(work, 'central.db')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

// ---- 建两个库（同一个 schema 构造器，保证结构一致）----
{
  const db = openDatabase(SHOP)
  const now = new Date().toISOString()
  db.prepare("INSERT INTO customers (id,name,phone,created_at) VALUES (9001,'张记渔具','13800000001',?)").run(now)
  db.prepare("INSERT INTO customers (id,name,phone,created_at) VALUES (9002,'李四','13800000002',?)").run(now)
  db.prepare("INSERT INTO customers (id,name,phone,created_at) VALUES (9003,'王五','13800000003',?)").run(now)
  db.prepare("INSERT INTO payments (id,customer_id,amount,method,created_at) VALUES (9001,9001,15000,'微信',?)").run(now)
  db.prepare("INSERT INTO payments (id,customer_id,amount,method,created_at) VALUES (9002,9002,8000,'现金',?)").run(now)
  // 4 笔零售出库，其中 1 笔 Shopee 且售价>0 —— 正是首单判据要的那一笔
  const tx = "INSERT INTO transactions (id,product_id,batch_id,type,quantity,unit_price,selling_price,timestamp,operator,notes,customer_id,paid_amount,pay_method,channel) VALUES (?,?,NULL,'out',?,?,?,?,'店长',NULL,?,NULL,'现金',?)"
  const pid = db.prepare('SELECT id FROM products ORDER BY id LIMIT 1').get().id
  db.prepare(tx).run(9001, pid, 2, 370, 900, now, null, '线下')
  db.prepare(tx).run(9002, pid, 1, 370, 1200, now, null, 'Shopee')
  db.prepare(tx).run(9003, pid, 3, 370, 1500, now, 9001, '线下')
  db.prepare(tx).run(9004, pid, 1, 370, 600, now, null, '线下')
  db.close()
}
{
  const db = openDatabase(TARGET)
  db.prepare("INSERT INTO customers (id,name,phone,created_at) VALUES (9001,'★中央库自己的张记（应被保住）','13900000000',?)").run(new Date().toISOString())
  db.close()
}

const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--src', SHOP, '--dst', TARGET, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status }
}
const scalar = (sql) => { const d = new DatabaseSync(TARGET, { readOnly: true }); const v = Object.values(d.prepare(sql).get())[0]; d.close(); return v }

console.log('\n=== ① 只读盘点：不改数据、分类正确 ===')
const before = scalar('SELECT COUNT(*) FROM customers')
const r1 = run([])
ok('只读模式未改目标库', scalar('SELECT COUNT(*) FROM customers') === before)
ok('2 个新增客户（9002/9003）', /customers\s+源\s+3\s+目标\s+1\s+新增\s+2/.test(r1.out), r1.out.match(/customers.*/)?.[0])
ok('1 个冲突客户（9001）', /customers.*冲突\s+1/.test(r1.out))
ok('2 个新增还款', /payments\s+源\s+2\s+目标\s+0\s+新增\s+2/.test(r1.out))
ok('4 个新增流水', /transactions.*新增\s+4/.test(r1.out))
ok('冲突行被列出，并明确提示不覆盖', /冲突（不覆盖/.test(r1.out))

console.log('\n=== ② --plan：只打印 SQL，仍不改数据 ===')
const r2 = run(['--plan'])
ok('给出 INSERT 样例', /INSERT INTO "customers"/.test(r2.out))
ok('未改数据', scalar('SELECT COUNT(*) FROM customers') === before)

console.log('\n=== ③ --apply --yes：备份自证 + 执行 ===')
const r3 = run(['--apply', '--yes'])
ok('执行成功', r3.code === 0, 'exit=' + r3.code)
ok('备份自证 integrity_check=ok', /integrity_check=ok/.test(r3.out))
ok('写后自证 4/4 流水', /transactions\s+目标库已存在 4\/4 行 ✓/.test(r3.out))

console.log('\n=== ④ 数据真的进去了 ===')
ok('客户 9002 名字正确', scalar('SELECT name FROM customers WHERE id=9002') === '李四')
ok('还款 9001 金额正确', scalar('SELECT amount FROM payments WHERE id=9001') === 15000)
ok('Shopee 那笔渠道正确', scalar('SELECT channel FROM transactions WHERE id=9002') === 'Shopee')

console.log('\n=== ⑤ 冲突行不被覆盖（最危险的失败模式）===')
ok('中央库自己的 9001 被保住', scalar('SELECT name FROM customers WHERE id=9001') === '★中央库自己的张记（应被保住）',
  '实际=' + scalar('SELECT name FROM customers WHERE id=9001'))

console.log('\n=== ⑥ 可重跑（幂等）===')
const r4 = run(['--apply', '--yes'])
ok('第二次报"没有需要新增的行"', /没有需要新增的行/.test(r4.out))
ok('客户数未变', scalar('SELECT COUNT(*) FROM customers') === before + 2)

console.log('\n=== ⑦ 端到端：搬完之后首单判据真的能翻转 ===')
const crit = scalar("SELECT COUNT(*) FROM transactions WHERE type='out' AND selling_price>0 AND channel='Shopee'")
const naive = scalar("SELECT COUNT(*) FROM transactions WHERE type='out' AND selling_price>0")
ok('补进 Shopee 零售后判据从 0 变 1（搬运解开了 P0）', crit === 1, 'crit=' + crit)
ok('线下零售也同时进来了 → 渠道条件是承重的', naive > crit, 'naive=' + naive + ' crit=' + crit)

try { fs.rmSync(work, { recursive: true, force: true }) } catch {}

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
