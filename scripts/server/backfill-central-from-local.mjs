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
//   3. 按主键逐行比对：只写「新增」；冲突只报告，绝不覆盖 —— 覆盖会静默改掉门店的账。
//   4. 跳过机器本地状态表；列取两边交集。分类口径见 scripts/server/lib/db-compare.mjs。
//   5. 整批一个事务，任一行失败全部回滚。
//
// 跑法：
//   node scripts/server/backfill-central-from-local.mjs --src <门店库> --dst <中央库>            # 只读盘点
//   node scripts/server/backfill-central-from-local.mjs --src <门店库> --dst <中央库> --plan     # 打印将执行的 SQL 样例
//   node scripts/server/backfill-central-from-local.mjs --src <门店库> --dst <中央库> --apply --yes
//   可选 --only=customers,payments   只处理指定表
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { classify, totals } from './lib/db-compare.mjs'

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

const src = new DatabaseSync(SRC, { readOnly: true })
const dst = new DatabaseSync(DST, { readOnly: !APPLY })

console.log('源库(门店): ' + SRC + '  ' + fs.statSync(SRC).size + ' 字节')
console.log('目标(中央): ' + DST + '  ' + fs.statSync(DST).size + ' 字节')
console.log('模式: ' + (APPLY ? '【执行搬运】' : '【只读盘点 不改任何数据】'))
console.log('')

const results = classify(src, dst, ONLY)
const plan = []

for (const r of results) {
  if (r.missing) { console.log(r.t.padEnd(22) + ' 跳过（' + (r.missing === 'src' ? '源库无此表' : '目标库无此表') + '）'); continue }
  if (r.shared && !r.shared.includes('id')) { console.log(r.t.padEnd(22) + ' 跳过（两边都没有 id 列，无法按主键比对）'); continue }

  console.log(r.t.padEnd(22) + ('源 ' + r.srcCount).padStart(10) + (' 目标 ' + r.dstCount).padStart(12) +
    (' 新增 ' + r.fresh.length).padStart(10) + (' 冲突 ' + r.conflict.length).padStart(9) + (' 已一致 ' + r.same).padStart(11))

  if (r.conflict.length) {
    console.log('    ⚠ 冲突（不覆盖，请人工决定）：')
    for (const c of r.conflict.slice(0, 5)) console.log('      id=' + c.id + ' 字段不同: ' + c.fields.join(','))
    if (r.conflict.length > 5) console.log('      …还有 ' + (r.conflict.length - 5) + ' 行')
  }
  if (r.dupRisk.length) {
    console.log('    ⚠ 疑似重复 ' + r.dupRisk.length + ' 行（自然键 ' + r.nk.join('+') + ' 与目标库已有行相同，但 id 不同）——')
    console.log('      这多半是两库分叉后同一笔业务各拿了一个 id。直接搬会产生重复单，请先人工确认：')
    for (const x of r.dupRisk.slice(0, 3)) console.log('      src id=' + x.id + '  ' + r.nk.map((c) => c + '=' + x[c]).join(' '))
    if (r.dupRisk.length > 3) console.log('      …还有 ' + (r.dupRisk.length - 3) + ' 行')
  }
  if (r.fresh.length) {
    plan.push({ t: r.t, shared: r.shared, rows: r.fresh })
    if (PLAN && !APPLY) {
      const r0 = r.fresh[0]
      console.log('    INSERT INTO "' + r.t + '" (' + r.shared.join(', ') + ') VALUES (' +
        r.shared.map((c) => JSON.stringify(r0[c] ?? null)).join(', ') + ');' +
        (r.fresh.length > 1 ? '  …共 ' + r.fresh.length + ' 行' : ''))
    }
  }
}

const tt = totals(results)
console.log('')
console.log('合计：新增 ' + tt.fresh + ' 行 / 冲突 ' + tt.conflict + ' 行（不写）/ 已一致 ' + tt.same + ' 行')

if (!APPLY) {
  console.log('\n（只读盘点结束，未改动任何数据。执行请加 --apply --yes）')
  if (tt.conflict) console.log('注意：有 ' + tt.conflict + ' 行冲突，执行时会被跳过，需要人工决定谁对。')
  src.close(); dst.close(); process.exit(0)
}

if (!YES) { console.error('\n拒绝执行：--apply 必须同时带 --yes'); process.exit(2) }
if (tt.fresh === 0) { console.log('\n没有需要新增的行，什么都不用做。'); src.close(); dst.close(); process.exit(0) }

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
    for (const row of rows) { stmt.run(...shared.map((c) => row[c] ?? null)); n++ }
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
