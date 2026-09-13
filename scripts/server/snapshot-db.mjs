// 通用「安全快照」工具：对**正在使用的** SQLite 库做一份一致快照。
//
// 为什么不能用 copy：活库在 WAL 模式下，主库文件 + 尚未 checkpoint 的 -wal 才构成完整状态。
// 直接拷 .db 拿到的是「旧的主库 + 缺失的 WAL」，可能缺最近事务、甚至拷到事务中途 ——
// 那不能当备份用，而当事人往往以为它有。（本项目 2026-09 两次迁移脚本都犯过这个错，已改。）
// VACUUM INTO 由 SQLite 自己在读事务里导出，是一致快照，且顺带紧凑化。
//
// 用法：
//   node scripts/server/snapshot-db.mjs --db <源库> [--out <目标>] [--label <后缀>]
//   node scripts/server/snapshot-db.mjs --db "%APPDATA%\fishing-inventory\data.db" --label pre-central-flip
// 不传 --out 时默认落在源库同目录：<源库>.snapshot-<label|时间戳>
//
// 退出码：0 成功；1 失败（快照与源库不一致时**主动报错**，绝不留下一个不能用的"备份"）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt }

const DB = arg('--db', path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'fishing-inventory', 'data.db'))
const label = arg('--label', new Date().toISOString().replace(/[:.]/g, '-'))
const OUT = path.resolve(arg('--out', DB + '.snapshot-' + label))

if (!fs.existsSync(DB)) { console.error('找不到源库：' + DB); process.exit(1) }
if (fs.existsSync(OUT)) { console.error('目标已存在，不覆盖：' + OUT); process.exit(1) }

console.log('源库  : ' + DB)
console.log('快照  : ' + OUT)

const db = new DatabaseSync(DB, { readOnly: true })
const srcSize = fs.statSync(DB).size

try {
  db.exec("VACUUM INTO '" + OUT.replace(/'/g, "''") + "'")
} catch (e) {
  console.error('VACUUM INTO 失败：' + e.message)
  db.close()
  process.exit(1)
}
db.close()

// 自证：快照能独立打开、完整性通过、表数与关键行数与源库一致。不一致就当失败。
const src = new DatabaseSync(DB, { readOnly: true })
const dst = new DatabaseSync(OUT, { readOnly: true })
const integrity = Object.values(dst.prepare('PRAGMA integrity_check').get())[0]
const tables = (d) => d.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
const rows = (d, t) => d.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n

console.log('大小  : ' + fs.statSync(OUT).size + ' 字节（源库 ' + srcSize + '）')
console.log('integrity_check: ' + integrity)
console.log('表数  : ' + tables(dst) + ' / ' + tables(src))

let ok = integrity === 'ok' && tables(dst) === tables(src)
if (!ok) console.error('✗ 快照与源库不一致（integrity 或表数）')

// 对业务表逐张比对行数（表名从源库取，避免写死）
const names = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)
const diffs = []
for (const t of names) {
  const a = rows(src, t), b = rows(dst, t)
  if (a !== b) diffs.push(`${t}: ${b} vs ${a}`)
}
if (diffs.length) { ok = false; console.error('✗ 行数不一致：' + diffs.join('; ')) }
else console.log('行数  : ' + names.length + ' 张表逐张一致')

src.close(); dst.close()

if (!ok) { console.error('\n快照不可信，请勿当退路。已保留文件供排查：' + OUT); process.exit(1) }
console.log('\n✓ 快照可用：' + OUT)
