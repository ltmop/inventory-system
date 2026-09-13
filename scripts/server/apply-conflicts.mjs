// 把「人工判定结果」落地：按判定文件修正目标库里那批冲突行。
//
// 为什么单独一个工具、而不是让搬运脚本顺手覆盖：
//   覆盖冲突行会静默改掉账。所以分两步 —— 人先判（conflict-report.mjs 出对照），
//   再用本工具**只改判定文件里明确列出的行**。没列的一行都不动，判错的也改不了别人。
//
// 判定文件格式（JSON）：
//   {
//     "note": "自由说明，留痕用",
//     "judgments": [
//       { "table": "inventory_batches", "id": 281, "take": "src", "why": "流水净剩 75，本机对" },
//       { "table": "products",          "id": 281, "take": "dst", "why": "中央库有成本 300" }
//     ]
//   }
//   take 只能是 "src"（取源库的值写进目标库）或 "dst"（保持目标库不动，仅登记判定）。
//
// 跑法：
//   node scripts/server/apply-conflicts.mjs --src <权威库> --dst <目标库> --judgments <判定.json>            # 只读预演
//   node scripts/server/apply-conflicts.mjs --src <权威库> --dst <目标库> --judgments <判定.json> --apply --yes
//
// 安全设计：
//   · 默认只读；执行要 --apply --yes，且先对目标库 VACUUM INTO 备份并自证
//   · 判定文件里列出的行，若**当前并不处于冲突状态**则拒绝执行（防止拿过期的判定去改库）
//   · 只改冲突的那几个字段，不整行替换（避免把目标库其他字段的更新冲掉）
//   · 整批一个事务；执行后重新比对，列出仍未解决的冲突
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { classifyTable, tableExists } from './lib/db-compare.mjs'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const SRC = arg('--src', '')
const DST = arg('--dst', '')
const JF = arg('--judgments', '')
const APPLY = argv.includes('--apply')
const YES = argv.includes('--yes')

if (!SRC || !DST || !JF) { console.error('用法: --src <权威库> --dst <目标库> --judgments <判定.json> [--apply --yes]'); process.exit(1) }
for (const [n, p] of [['源库', SRC], ['目标库', DST], ['判定文件', JF]]) {
  if (!fs.existsSync(p)) { console.error('找不到' + n + '：' + p); process.exit(1) }
}

const doc = JSON.parse(fs.readFileSync(JF, 'utf8'))
const judgments = Array.isArray(doc) ? doc : (doc.judgments ?? [])
if (!judgments.length) { console.error('判定文件里没有 judgments'); process.exit(1) }

const src = new DatabaseSync(SRC, { readOnly: true })
const dst = new DatabaseSync(DST, { readOnly: !APPLY })

console.log('源库(权威): ' + SRC)
console.log('目标库    : ' + DST)
console.log('判定文件  : ' + JF + '（' + judgments.length + ' 条' + (doc.note ? '；' + doc.note : '') + '）')
console.log('模式: ' + (APPLY ? '【执行修正】' : '【只读预演 不改任何数据】'))
console.log('')

// 逐条校验：必须是真冲突，take 必须合法
const todo = []
const problems = []
const byTable = new Map()
for (const j of judgments) {
  if (!j.table || j.id == null || !['src', 'dst'].includes(j.take)) { problems.push('格式不对: ' + JSON.stringify(j)); continue }
  if (!byTable.has(j.table)) byTable.set(j.table, [])
  byTable.get(j.table).push(j)
}

for (const [t, list] of byTable) {
  if (!tableExists(src, t) || !tableExists(dst, t)) { problems.push(`表不存在: ${t}`); continue }
  const r = classifyTable(src, dst, t)
  const confById = new Map(r.conflict.map((c) => [c.id, c]))
  for (const j of list) {
    const c = confById.get(j.id)
    if (!c) { problems.push(`${t} id=${j.id} 当前**并不是冲突行**（可能已修过或判定过期）`); continue }
    if (!r.shared.includes('id')) { problems.push(`${t} 没有 id 列`); continue }
    todo.push({ t, j, fields: c.fields, shared: r.shared })
  }
}

if (problems.length) {
  console.error('拒绝执行：判定文件与当前库状态不符 ——')
  for (const p of problems) console.error('  · ' + p)
  console.error('\n（判定可能是按旧快照做的；请重新生成对照报告并复核后再来。）')
  process.exit(2)
}

console.log('将执行的修正：')
let willWrite = 0
for (const { t, j, fields } of todo) {
  if (j.take === 'dst') { console.log(`  ${t} id=${j.id}  取目标（保持不动）  ${j.why ?? ''}`); continue }
  willWrite++
  const a = src.prepare(`SELECT ${fields.map((f) => `"${f}"`).join(',')} FROM "${t}" WHERE id=?`).get(j.id)
  const b = dst.prepare(`SELECT ${fields.map((f) => `"${f}"`).join(',')} FROM "${t}" WHERE id=?`).get(j.id)
  console.log(`  ${t} id=${j.id}  取源：` + fields.map((f) => `${f} ${JSON.stringify(b[f] ?? null)} → ${JSON.stringify(a[f] ?? null)}`).join('，') + `   ${j.why ?? ''}`)
}
console.log(`\n合计：需要写 ${willWrite} 行，登记不改 ${todo.length - willWrite} 行`)

if (!APPLY) { console.log('\n（只读预演结束，未改动任何数据。执行请加 --apply --yes）'); src.close(); dst.close(); process.exit(0) }
if (!YES) { console.error('\n拒绝执行：--apply 必须同时带 --yes'); process.exit(2) }
if (willWrite === 0) { console.log('\n没有需要写入的行。'); src.close(); dst.close(); process.exit(0) }

// 备份 + 自证
const backup = DST + '.bak-preconflictfix-' + new Date().toISOString().replace(/[:.]/g, '-')
let how = 'VACUUM INTO（在线一致快照）'
try { dst.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'") }
catch (e) { how = 'copyFileSync 回退（' + e.message + '）'; fs.copyFileSync(DST, backup) }
console.log('\n已对目标库备份: ' + backup + '（' + how + '）')
try {
  const b = new DatabaseSync(backup, { readOnly: true })
  const icv = Object.values(b.prepare('PRAGMA integrity_check').get())[0]
  const bt = b.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
  const dt = dst.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
  b.close()
  console.log('  自证: integrity_check=' + icv + '，表 ' + bt + '/' + dt)
  if (icv !== 'ok' || bt !== dt) { console.error('\n拒绝执行：备份不可信。'); process.exit(1) }
} catch (e) { console.error('\n拒绝执行：备份打开失败（' + e.message + '）'); process.exit(1) }

dst.exec('BEGIN IMMEDIATE')
try {
  let n = 0
  for (const { t, j, fields } of todo) {
    if (j.take !== 'src') continue
    const a = src.prepare(`SELECT ${fields.map((f) => `"${f}"`).join(',')} FROM "${t}" WHERE id=?`).get(j.id)
    dst.prepare(`UPDATE "${t}" SET ${fields.map((f) => `"${f}"=?`).join(', ')} WHERE id=?`).run(...fields.map((f) => a[f] ?? null), j.id)
    n++
  }
  dst.exec('COMMIT')
  console.log('\n修正完成，改写了 ' + n + ' 行。')
} catch (e) {
  dst.exec('ROLLBACK')
  console.error('\n失败已整体回滚：' + e.message)
  process.exit(1)
}

// 写后复核
console.log('\n写后复核：')
const byTable2 = new Map()
for (const { t } of todo) byTable2.set(t, true)
let left = 0
for (const t of byTable2.keys()) {
  const r = classifyTable(src, dst, t)
  left += r.conflict.length
  const adjudicated = todo.filter((x) => x.t === t && x.j.take === 'dst').length
  console.log('  ' + t.padEnd(22) + ' 剩余差异 ' + r.conflict.length + ' 行' +
    (adjudicated ? '（其中 ' + adjudicated + ' 行是判定「取目标」，差异保留属预期）' : ''))
}
console.log('\n注意：判定文件里 take="dst" 的行，差异会**一直存在**（因为判定就是"目标库对"）。')
console.log('      那是已裁决的差异，不是未处理 —— 下次生成对照报告时它们还会出现，属正常。')
console.log('\n回退：用 ' + backup + ' 覆盖目标库（先停服务）。')
src.close(); dst.close()
process.exit(0)
