#!/usr/bin/env node
/**
 * 多端同步  阶段二之一：变更捕获（CDC）
 *
 * 目标：让"本机改了什么"能被增量地读出来，供同步引擎逐条推送。
 * 做法：纯加法建一张 sync_changelog，再给 19 张同步表各挂 3 个触发器（增/改/删）。
 *
 * 为什么用触发器、而不是去改 app 的写入代码：
 *   盘点发现写入面极广（products 16 处、inventory_batches 15 处、transactions 14 处 ），
 *   逐个改既漏又危险；触发器是数据库层兜底，一处不漏，且 app 代码零改动。
 *
 * 关键设计决定：同步用的"谁新谁赢"时间戳 = sync_changelog.at（变更发生那一刻），
 *   而不是各表的 updated_at  因为 app 的写入路径并不会去维护那些新加的列，
 *   用它们会判错。触发器记的时间天然就是"最后一次在本机被改"的时刻。
 *
 * 用法：
 *   node scripts/migrate-sync-changelog.mjs                # 只读盘点（默认）
 *   node scripts/migrate-sync-changelog.mjs --plan          # 打印将执行的 DDL
 *   node scripts/migrate-sync-changelog.mjs --apply --yes   # 执行（先整库备份；请先关闭客户端）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const SYNCABLE = [
  'products', 'inventory_batches', 'transactions', 'stock_takes', 'stock_take_items',
  'categories', 'units', 'suppliers', 'customers', 'payments', 'expenses',
  'purchase_orders', 'purchase_order_items', 'price_tiers', 'kits', 'kit_items',
  'supplier_payments', 'waste_logs', 'payment_registers',
]

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

const CHANGELOG_DDL =
  'CREATE TABLE IF NOT EXISTS sync_changelog (\n' +
  '  seq  INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
  '  tbl  TEXT NOT NULL,\n' +
  '  guid TEXT NOT NULL,\n' +
  "  op   TEXT NOT NULL CHECK (op IN ('I','U','D')),\n" +
  '  at   TEXT NOT NULL\n' +
  ')'
const IDX_DDL = 'CREATE INDEX IF NOT EXISTS ix_sync_changelog_guid ON sync_changelog(guid)'

function trigInsert(t) {
  return (
    `CREATE TRIGGER IF NOT EXISTS "trg_${t}_ins" AFTER INSERT ON "${t}"\n` +
    'BEGIN\n' +
    `  UPDATE "${t}" SET guid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid AND (guid IS NULL OR guid = '');\n` +
    "  INSERT INTO sync_changelog (tbl, guid, op, at)\n" +
    `    SELECT '${t}', guid, 'I', ${NOW} FROM "${t}" WHERE rowid = NEW.rowid AND guid IS NOT NULL;\n` +
    'END;'
  )
}
function trigUpdate(t, cols) {
  const changed = cols.filter((c) => c !== 'guid').map((c) => `NEW."${c}" IS NOT OLD."${c}"`).join(' OR ')
  return (
    `CREATE TRIGGER IF NOT EXISTS "trg_${t}_upd" AFTER UPDATE ON "${t}"\n` +
    `WHEN NEW.guid IS NOT NULL AND (${changed})\n` +
    'BEGIN\n' +
    `  INSERT INTO sync_changelog (tbl, guid, op, at) VALUES ('${t}', NEW.guid, 'U', ${NOW});\n` +
    'END;'
  )
}
function trigDelete(t) {
  return (
    `CREATE TRIGGER IF NOT EXISTS "trg_${t}_del" AFTER DELETE ON "${t}"\n` +
    'WHEN OLD.guid IS NOT NULL\n' +
    'BEGIN\n' +
    `  INSERT INTO sync_changelog (tbl, guid, op, at) VALUES ('${t}', OLD.guid, 'D', ${NOW});\n` +
    'END;'
  )
}

function resolveDbPath(argv) {
  const i = argv.indexOf('--db')
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'fishing-inventory', 'data.db')
}

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const PLAN = argv.includes('--plan') || APPLY
const YES = argv.includes('--yes')
const DB = resolveDbPath(argv)
if (!fs.existsSync(DB)) { console.error('找不到数据库: ' + DB); process.exit(1) }

console.log('数据库: ' + DB)
console.log('模式: ' + (APPLY ? '【执行 CDC 迁移】' : '【只读盘点  不改任何数据】'))
console.log('')

const db = new DatabaseSync(DB, { readOnly: !APPLY })

// ---- 前置：guid 必须已就位（依赖 Phase 1） ----
const missingGuid = []
const tables = []
for (const t of SYNCABLE) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
  if (!exists) continue
  const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)
  if (!cols.includes('guid')) missingGuid.push(t)
  const n = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n
  const has = (nm) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(nm)
  tables.push({ t, cols, n, ins: has(`trg_${t}_ins`), upd: has(`trg_${t}_upd`), del: has(`trg_${t}_del`) })
}
const hasChangelog = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_changelog'").get()
const changelogRows = hasChangelog ? db.prepare('SELECT COUNT(*) n FROM sync_changelog').get().n : 0

if (missingGuid.length) {
  console.error(' 前置未满足：以下表还没有 guid 列，请先执行 scripts/migrate-sync-readiness.mjs --apply --yes')
  console.error('  ' + missingGuid.join(', '))
  process.exit(3)
}

console.log(`变更日志表 sync_changelog: ${hasChangelog ? '已存在（' + changelogRows + ' 行）' : '不存在（将创建）'}`)
console.log('')
console.log('表名'.padEnd(22) + '行数'.padStart(7) + '   增触发器  改触发器  删触发器')
console.log('-'.repeat(64))
let needIns = 0, needUpd = 0, needDel = 0
for (const r of tables) {
  if (!r.ins) needIns++
  if (!r.upd) needUpd++
  if (!r.del) needDel++
  console.log(r.t.padEnd(22) + String(r.n).padStart(7) + '   ' +
    (r.ins ? '  已有  ' : '  需建  ') + (r.upd ? '   已有  ' : '   需建  ') + (r.del ? '   已有' : '   需建'))
}
console.log('-'.repeat(64))
console.log(`共 ${tables.length} 张表；需建触发器 增 ${needIns} / 改 ${needUpd} / 删 ${needDel} 个`)

if (PLAN && !APPLY) {
  console.log('\n--- 将要执行的 DDL（节选） ---')
  console.log(CHANGELOG_DDL + ';')
  console.log(IDX_DDL + ';')
  console.log(trigInsert(tables[0].t))
  console.log(trigUpdate(tables[0].t, tables[0].cols))
  console.log(trigDelete(tables[0].t))
  console.log(`... 其余 ${tables.length - 1} 张表同构`)
}

if (!APPLY) {
  db.close()
  console.log('\n（只读盘点结束，未改动任何数据。执行请加 --apply --yes，并先关闭客户端）')
  process.exit(0)
}

// ---------- 执行 ----------
if (!YES) { console.error('\n拒绝执行：--apply 必须同时带 --yes（且请先关闭客户端）'); process.exit(2) }
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${DB}.bak-pregcdc-${stamp}`
fs.copyFileSync(DB, backup)
console.log('\n已整库备份: ' + backup)

db.exec('BEGIN IMMEDIATE')
try {
  db.exec(CHANGELOG_DDL)
  db.exec(IDX_DDL)
  console.log('  已建 sync_changelog + 索引')
  let made = 0
  for (const r of tables) {
    db.exec(trigInsert(r.t))
    db.exec(trigUpdate(r.t, r.cols))
    db.exec(trigDelete(r.t))
    made += 3
  }
  console.log(`  已建 ${made} 个触发器`)

  // ---- 功能自检：真插一条、真改一条、真删一条，看日志对不对 ----
  const probe = '__cdc_probe__' + Date.now()
  db.prepare('INSERT INTO categories (name) VALUES (?)').run(probe)
  const row = db.prepare('SELECT id, guid FROM categories WHERE name = ?').get(probe)
  if (!row || !row.guid || !/^[0-9a-f]{32}$/.test(row.guid)) throw new Error('自检失败：新插入行的 guid 未被自动填充（' + JSON.stringify(row) + '）')
  db.prepare('UPDATE categories SET sort_order = sort_order + 1 WHERE id = ?').run(row.id)
  db.prepare('DELETE FROM categories WHERE id = ?').run(row.id)
  const ops = db.prepare('SELECT op FROM sync_changelog WHERE tbl = ? AND guid = ? ORDER BY seq').all('categories', row.guid).map((x) => x.op)
  if (ops.join(',') !== 'I,U,D') throw new Error('自检失败：期望 I,U,D，实际 ' + ops.join(',') + '（guid=' + row.guid + '）')
  const left = db.prepare('SELECT COUNT(*) n FROM categories WHERE name = ?').get(probe).n
  if (left !== 0) throw new Error('自检失败：探针行未清理干净')
  db.prepare('DELETE FROM sync_changelog WHERE guid = ?').run(row.guid)
  console.log('  自检通过：新行 guid 自动填充；增/改/删依次记为 I,U,D；探针已清理')

  db.exec('COMMIT')
  console.log('\nCDC 迁移完成。回滚：关闭客户端  用 ' + backup + ' 覆盖 data.db  删除 data.db-wal / data.db-shm')
  console.log('注意：sync_changelog 只增不减，同步引擎（阶段 2.2）会在每条成功推送后按游标裁剪。')
} catch (e) {
  db.exec('ROLLBACK')
  console.error('\n迁移失败已整体回滚: ' + e.message)
  process.exit(1)
}
db.close()