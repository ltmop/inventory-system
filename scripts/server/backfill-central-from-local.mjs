// 一次性搬运：把门店本机库的业务数据补进中央库（中心库归一的第 1 步）
//
// 背景（为什么不能直接翻转）：
//   中央库当前 customers=0、payments=0，而门店的真实零售/客户/应收还在门店本机。
//   桌面切到中心库后**只看得见中心库那份数据**（src/lib/api.ts：中心库覆盖本地 IPC），
//   所以先翻转会让门店看不到自己的赊账客户和应收 —— 必须先补数据、核对账实，再翻转。
//   见 docs/运维-中心库归一-翻转Runbook.md
//
// 设计原则（这是往生产库里写数据，保守优先）：
//   1. 默认只读盘点，什么都不改。执行要 `--apply --yes`。
//   2. 写之前对**目标库**做 VACUUM INTO 快照并自证（不一致就拒绝执行）。
//   3. 按主键（id）逐行比对，分三类：新增 / 冲突 / 已一致。**只写「新增」**。
//      冲突（同 id 但业务字段不同）只报告，绝不覆盖 —— 覆盖会静默改掉门店的账。
//   4. 只搬两边都有的列（取交集）。中央库没有 guid 而门店库有，这类不对称自动跳过。
//   5. 跳过机器本地状态表（settings/users/idem/ai_*/audit_log/sync_*），那些不是业务数据。
//   6. 整批一个事务，任一行失败全部回滚。
//
// 跑法：
//   node scripts/server/backfill-central-from-local.mjs --src <门店库> --dst <中央库>            # 只读盘点
//   node scripts/server/backfill-central-from-local.mjs --src <门店库> --dst <中央库> --plan     # 打印将执行的 SQL 样例
//   node scripts/server/backfill-central-from-local.mjs --src <门店库> --dst <中央库> --apply --yes
//   可选 --only=customers,payments   只处理指定表
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const SRC = arg('--src', '')
const DST = arg('--dst', '')
const PLAN = argv.includes('--plan') || argv.includes('--apply')
const APPLY = argv.includes('--apply')
const YES = argv.includes('--yes')
const ONLY = arg('--only', '') ? arg('--only', '').split(',').map((s) => s.trim()).filter(Boolean) : null

if (!SRC || !DST) { console.error('用法: --src <门店库> --dst <中央库> [--plan] [--apply --yes] [--only=t1,t2]'); process.exit(1) }
for (const [n, p] of [['源库(门店)', SRC], ['目标库(中央)', DST]]) {
  if (!fs.existsSync(p)) { console.error('找不到' + n + '：' + p); process.exit(1) }
}

// 父子顺序：父表在前，子表的外键才有指向。SQLite 默认不强制外键，但顺序错了会留下悬空引用。
const COPY_ORDER = [
  'categories', 'units', 'suppliers', 'customers', 'products', 'price_tiers', 'kits',
  'inventory_batches', 'kit_items', 'purchase_orders', 'stock_takes',
  'transactions', 'payments', 'expenses', 'purchase_order_items', 'stock_take_items',
  'supplier_payments', 'waste_logs', 'payment_registers',
]
// 机器本地状态 / 非业务数据：不搬
const SKIP = new Set(['settings', 'users', 'idem', 'ai_insights', 'ai_messages', 'ai_usage', 'audit_log', 'sync_changelog', 'sync_outbox'])
// 比对时忽略：guid 是各库自己生成的，updated_at 是各机维护的，都不构成"业务内容不同"
const IGNORE_IN_COMPARE = new Set(['guid', 'updated_at'])

// 自然键重复预警。
// 去重是按 id 做的，前提是两库同源（ids 对得上）。但两库一旦分叉过，
// 同一笔业务可能在两边有**不同 id** —— 那样会当成新行插进去，变成重复单。
// 这是本脚本最贵的错误（重复单要人工冲销），所以按业务自然键再扫一遍，只报警不拦。
const NATURAL_KEY = {
  customers: ['name'],
  transactions: ['product_id', 'timestamp', 'quantity'],
  payments: ['customer_id', 'amount', 'created_at'],
}

const src = new DatabaseSync(SRC, { readOnly: true })
const dst = new DatabaseSync(DST, { readOnly: !APPLY })

const tableExists = (db, t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
const colsOf = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)

console.log('源库(门店): ' + SRC + '  ' + fs.statSync(SRC).size + ' 字节')
console.log('目标(中央): ' + DST + '  ' + fs.statSync(DST).size + ' 字节')
console.log('模式: ' + (APPLY ? '【执行搬运】' : '【只读盘点 不改任何数据】'))
console.log('')

const plan = []
let totalNew = 0, totalConflict = 0, totalSame = 0

for (const t of COPY_ORDER) {
  if (ONLY && !ONLY.includes(t)) continue
  if (SKIP.has(t)) continue
  if (!tableExists(src, t) || !tableExists(dst, t)) {
    console.log(t.padEnd(22) + ' 跳过（' + (!tableExists(src, t) ? '源库无此表' : '目标库无此表') + '）')
    continue
  }
  const shared = colsOf(src, t).filter((c) => colsOf(dst, t).includes(c))
  if (!shared.includes('id')) { console.log(t.padEnd(22) + ' 跳过（两边都没有 id 列，无法按主键比对）'); continue }

  const srcRows = src.prepare(`SELECT ${shared.map((c) => `"${c}"`).join(',')} FROM "${t}"`).all()
  const dstRows = dst.prepare(`SELECT ${shared.map((c) => `"${c}"`).join(',')} FROM "${t}"`).all()
  const dstById = new Map(dstRows.map((r) => [r.id, r]))

  const cmpCols = shared.filter((c) => c !== 'id' && !IGNORE_IN_COMPARE.has(c))
  const fresh = [], conflict = []
  for (const r of srcRows) {
    const d = dstById.get(r.id)
    if (d === undefined) { fresh.push(r); continue }
    const differs = cmpCols.some((c) => (r[c] ?? null) !== (d[c] ?? null))
    if (differs) conflict.push({ id: r.id, fields: cmpCols.filter((c) => (r[c] ?? null) !== (d[c] ?? null)) })
  }
  const same = srcRows.length - fresh.length - conflict.length
  totalNew += fresh.length; totalConflict += conflict.length; totalSame += same

  // 自然键重复预警：新行里有没有和目标库某行"业务上像同一笔"的
  const nk = NATURAL_KEY[t]
  let dupRisk = []
  if (nk && nk.every((c) => shared.includes(c)) && fresh.length) {
    const keyOf = (r) => nk.map((c) => String(r[c] ?? '\u0000')).join('|')
    const dstKeys = new Set(dstRows.map(keyOf))
    dupRisk = fresh.filter((r) => dstKeys.has(keyOf(r)))
  }

  console.log(t.padEnd(22) + ('源 ' + srcRows.length).padStart(10) + (' 目标 ' + dstRows.length).padStart(12) +
    (' 新增 ' + fresh.length).padStart(10) + (' 冲突 ' + conflict.length).padStart(9) + (' 已一致 ' + same).padStart(11))
  if (dupRisk.length) {
    console.log('    ⚠ 疑似重复 ' + dupRisk.length + ' 行（自然键 ' + nk.join('+') + ' 与目标库已有行相同，但 id 不同）——')
    console.log('      这多半是两库分叉后同一笔业务各拿了一个 id。直接搬会产生重复单，请先人工确认：')
    for (const r of dupRisk.slice(0, 3)) console.log('      src id=' + r.id + '  ' + nk.map((c) => c + '=' + r[c]).join(' '))
    if (dupRisk.length > 3) console.log('      …还有 ' + (dupRisk.length - 3) + ' 行')
  }
  if (conflict.length) {
    console.log('    ⚠ 冲突（不覆盖，请人工决定）：')
    for (const c of conflict.slice(0, 5)) console.log('      id=' + c.id + ' 字段不同: ' + c.fields.join(','))
    if (conflict.length > 5) console.log('      …还有 ' + (conflict.length - 5) + ' 行')
  }
  if (fresh.length) {
    plan.push({ t, shared, rows: fresh })
    if (PLAN && !APPLY) {
      const r0 = fresh[0]
      console.log('    INSERT INTO "' + t + '" (' + shared.join(', ') + ') VALUES (' +
        shared.map((c) => JSON.stringify(r0[c] ?? null)).join(', ') + ');' +
        (fresh.length > 1 ? '  …共 ' + fresh.length + ' 行' : ''))
    }
  }
}

console.log('')
console.log('合计：新增 ' + totalNew + ' 行 / 冲突 ' + totalConflict + ' 行（不写）/ 已一致 ' + totalSame + ' 行')

if (!APPLY) {
  console.log('\n（只读盘点结束，未改动任何数据。执行请加 --apply --yes）')
  if (totalConflict) console.log('注意：有 ' + totalConflict + ' 行冲突，执行时会被跳过，需要人工决定谁对。')
  src.close(); dst.close(); process.exit(0)
}

if (!YES) { console.error('\n拒绝执行：--apply 必须同时带 --yes'); process.exit(2) }
if (totalNew === 0) { console.log('\n没有需要新增的行，什么都不用做。'); src.close(); dst.close(); process.exit(0) }

// ---------- 写之前：对目标库做快照并自证 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = DST + '.bak-prebackfill-' + stamp
let how = 'VACUUM INTO（在线一致快照）'
try {
  dst.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'")
} catch (e) {
  how = 'copyFileSync 回退（' + e.message + '）—— 请确认中央库服务已停'
  fs.copyFileSync(DST, backup)
}
console.log('\n已对目标库备份: ' + backup)
console.log('  方式: ' + how + '，大小 ' + fs.statSync(backup).size + ' 字节')
try {
  const b = new DatabaseSync(backup, { readOnly: true })
  const icv = Object.values(b.prepare('PRAGMA integrity_check').get())[0]
  const bt = b.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
  const dt = dst.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
  b.close()
  console.log('  自证: integrity_check=' + icv + '，表 ' + bt + '/' + dt)
  if (icv !== 'ok' || bt !== dt) { console.error('\n拒绝执行：备份与目标库不一致，不能拿它当退路。'); process.exit(1) }
} catch (e) {
  console.error('\n拒绝执行：备份打开失败（' + e.message + '）'); process.exit(1)
}

// ---------- 执行 ----------
dst.exec('BEGIN IMMEDIATE')
try {
  let n = 0
  for (const { t, shared, rows } of plan) {
    const sql = `INSERT INTO "${t}" (${shared.map((c) => `"${c}"`).join(',')}) VALUES (${shared.map(() => '?').join(',')})`
    const stmt = dst.prepare(sql)
    for (const r of rows) { stmt.run(...shared.map((c) => r[c] ?? null)); n++ }
    console.log('  ' + t.padEnd(22) + ' 写入 ' + rows.length + ' 行')
  }
  dst.exec('COMMIT')
  console.log('\n搬运完成，共写入 ' + n + ' 行。')
} catch (e) {
  dst.exec('ROLLBACK')
  console.error('\n失败已整体回滚：' + e.message)
  process.exit(1)
}

// ---------- 写后自证 ----------
console.log('\n写后核对：')
for (const { t, rows } of plan) {
  const c = dst.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE id IN (${rows.map(() => '?').join(',')})`).get(...rows.map((r) => r.id)).n
  console.log('  ' + t.padEnd(22) + ' 目标库已存在 ' + c + '/' + rows.length + ' 行' + (c === rows.length ? ' ✓' : ' ✗'))
}
console.log('\n回退：用 ' + backup + ' 覆盖目标库（先停服务）。')
console.log('接下来必须做的：核对账实（客户数/应收合计/本月零售笔数）与门店基线一致，再翻转。')

src.close(); dst.close()
