// 两个库的「冲突对照报告」：把同 id 但内容不同的行，逐字段并排列出来给人判。
//
// 为什么需要它：搬运脚本按设计**不覆盖**冲突行（覆盖会静默改掉门店的账），
// 于是这些行必须由人判定谁对。直接对着 SQL 比字段既慢又容易看漏，
// 所以把它们导出成一份并排对照 —— 判 17 行应该是十分钟的事，不是一小时。
//
// 跑法：
//   node scripts/server/conflict-report.mjs --src <库A> --dst <库B> [--out 报告.md] [--all-fields]
//   node scripts/server/conflict-report.mjs --src <门店库> --dst <中央库> --labels "门店,中央库"
// 不传 --out 时打印到屏幕。
//
// 说明：判定标准与搬运脚本**同一份代码**（scripts/server/lib/db-compare.mjs），
// 所以报告里说"冲突"的行，就是搬运时会跳过、需要人判的那批，不会两处不一致。
import fs from 'node:fs'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { classify, totals, IGNORE_IN_COMPARE, SKIP } from './lib/db-compare.mjs'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const SRC = arg('--src', '')
const DST = arg('--dst', '')
const OUT = arg('--out', '')
const ALL = argv.includes('--all-fields')
const [LA, LB] = arg('--labels', '源,目标').split(',')

if (!SRC || !DST) { console.error('用法: --src <库A> --dst <库B> [--out 报告.md] [--all-fields] [--labels "A,B"]'); process.exit(1) }
for (const p of [SRC, DST]) if (!fs.existsSync(p)) { console.error('找不到：' + p); process.exit(1) }

const src = new DatabaseSync(SRC, { readOnly: true })
const dst = new DatabaseSync(DST, { readOnly: true })

const meta = (p) => ({
  size: fs.statSync(p).size,
  mtime: fs.statSync(p).mtime.toISOString(),
  sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
})
const ms = meta(SRC), md = meta(DST)

// 金额字段（单位：分）额外折算成元，避免人对着一串数字数小数点
const MONEY = new Set(['unit_price', 'selling_price', 'paid_amount', 'amount', 'cost_price', 'suggest_price', 'refund_price', 'diff_paid_amount'])
const fmt = (col, v) => {
  if (v === null || v === undefined) return '`NULL`'
  if (MONEY.has(col) && typeof v === 'number') return '`' + v + '` (¥' + (v / 100).toFixed(2) + ')'
  return '`' + String(v) + '`'
}

const results = classify(src, dst)
const tt = totals(results)
const conflicted = results.filter((r) => r.conflict?.length)
const freshOnes = results.filter((r) => r.fresh?.length)
const dupOnes = results.filter((r) => r.dupRisk?.length)

const L = []
L.push('# 两库冲突对照报告')
L.push('')
L.push('> 用途：搬运脚本**不会覆盖**同 id 但内容不同的行（覆盖会静默改掉门店的账）。')
L.push('> 这份报告把那批行逐字段并排列出来，由人判定谁对，再决定怎么处理。')
L.push('')
L.push('## 输入')
L.push('')
L.push(`- **${LA}**（--src）：\`${SRC}\``)
L.push(`  - ${ms.size} 字节，mtime ${ms.mtime}`)
L.push(`  - sha256 \`${ms.sha256}\``)
L.push(`- **${LB}**（--dst）：\`${DST}\``)
L.push(`  - ${md.size} 字节，mtime ${md.mtime}`)
L.push(`  - sha256 \`${md.sha256}\``)
L.push('')
L.push(`判定口径与 \`scripts/server/backfill-central-from-local.mjs\` 同源（\`scripts/server/lib/db-compare.mjs\`）：`)
L.push(`按主键 \`id\` 匹配；忽略 ${[...IGNORE_IN_COMPARE].join('、')}；`)
L.push(`${SKIP.size} 张机器本地状态表不参与比对。`)
L.push('')
L.push('## 总览')
L.push('')
L.push(`| 项 | 行数 |`)
L.push(`|---|---|`)
L.push(`| 冲突（需人判，搬运会跳过） | **${tt.conflict}** |`)
L.push(`| 新增（搬运会写入 ${LB}） | ${tt.fresh} |`)
L.push(`| 已一致 | ${tt.same} |`)
L.push('')
L.push('| 表 | 冲突 | 新增 | 已一致 | 源行数 | 目标行数 |')
L.push('|---|---|---|---|---|---|')
for (const r of results) {
  if (r.missing) continue
  const mark = r.conflict?.length ? ' ⚠' : ''
  L.push(`| \`${r.t}\`${mark} | ${r.conflict?.length ?? 0} | ${r.fresh?.length ?? 0} | ${r.same ?? 0} | ${r.srcCount} | ${r.dstCount} |`)
}
L.push('')

if (dupOnes.length) {
  L.push('## ⚠️ 疑似重复（自然键相同但 id 不同 → 直接搬会产生重复单）')
  L.push('')
  for (const r of dupOnes) {
    L.push(`### \`${r.t}\`（${r.dupRisk.length} 行）`)
    L.push('')
    L.push(`自然键：${r.nk.join(' + ')}`)
    L.push('')
    L.push(`| 源 id | ${r.nk.join(' | ')} |`)
    L.push(`|---|${r.nk.map(() => '---').join('|')}|`)
    for (const x of r.dupRisk) L.push(`| ${x.id} | ${r.nk.map((c) => fmt(c, x[c])).join(' | ')} |`)
    L.push('')
  }
}

L.push('## 冲突逐行对照')
L.push('')
if (!conflicted.length) L.push('（没有冲突）')
for (const r of conflicted.slice().sort((a, b) => b.conflict.length - a.conflict.length)) {
  const srcRows = src.prepare(`SELECT ${r.shared.map((c) => `"${c}"`).join(',')} FROM "${r.t}"`).all()
  const dstRows = dst.prepare(`SELECT ${r.shared.map((c) => `"${c}"`).join(',')} FROM "${r.t}"`).all()
  const byId = new Map(srcRows.map((x) => [x.id, x]))
  const byId2 = new Map(dstRows.map((x) => [x.id, x]))
  L.push(`### \`${r.t}\`（${r.conflict.length} 行冲突）`)
  L.push('')
  for (const c of r.conflict) {
    const a = byId.get(c.id) ?? {}, b = byId2.get(c.id) ?? {}
    L.push(`#### id=${c.id}`)
    L.push('')
    L.push(`| 字段 | ${LA}（源） | ${LB}（目标） |`)
    L.push('|---|---|---|')
    for (const f of c.fields) L.push(`| **${f}** | ${fmt(f, a[f])} | ${fmt(f, b[f])} |`)
    if (ALL) {
      const same = r.shared.filter((x) => x !== 'id' && !c.fields.includes(x) && !IGNORE_IN_COMPARE.has(x))
      for (const f of same) L.push(`| ${f} | ${fmt(f, a[f])} | ${fmt(f, b[f])} |`)
    }
    L.push('')
  }
  L.push('')
}

L.push('## 怎么处理')
L.push('')
L.push('判定原则（供参考，最终由了解现场的人定）：')
L.push('')
L.push(`1. **一行只能有一个真相。** 判完之后，输的那一侧要按处理方式修正，不能两边都留着。`)
L.push(`2. 金额/数量类冲突要特别小心：它直接影响账实与毛利，宁可按实物账本核对。`)
L.push(`3. 判定结果请**写回这里**（在下表打勾），作为搬运执行的依据与留痕。`)
L.push('')
L.push('| 表 | id | 判定 | 判定人 | 备注 |')
L.push('|---|---|---|---|---|')
for (const r of conflicted) for (const c of r.conflict) L.push(`| \`${r.t}\` | ${c.id} | ☐ 取源 / ☐ 取目标 / ☐ 都不对 | | |`)
L.push('')
L.push('---')
L.push('')
L.push(`报告生成：${new Date().toISOString()}`)
L.push('')

src.close(); dst.close()
const text = L.join('\n')
if (OUT) { fs.writeFileSync(OUT, text, 'utf8'); console.log('报告已写出: ' + OUT) }
else console.log(text)
console.log('\n冲突 ' + tt.conflict + ' 行 / 新增 ' + tt.fresh + ' 行 / 疑似重复 ' + dupOnes.reduce((s, r) => s + r.dupRisk.length, 0) + ' 行')
