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

// 触发器内容比对：sqlite_master 里存的是当时那条 CREATE 原文，写法差异（引号/大小写/空白）
// 不该算"变了"，所以归一化后再比。真正要抓的是**列集合变化** —— 见下面 upd 触发器。
function normSql(s) {
  return String(s ?? '')
    .replace(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS/gi, 'CREATE TRIGGER')
    .replace(/["'`]/g, '')
    // 分号：SQLite 存下的原文常常没有结尾 END;（当初建的时候就没写），
    // 而这里现算的 SQL 带分号。语句分隔符不构成语义差异，必须吃掉，
    // 否则 57 个触发器全报"过旧"，真正的信号（列集合变了）反而被噪声淹没。
    .replace(/;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
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
  // 关键：不能只看触发器"在不在"。upd 触发器的 WHEN 子句是**按当时的列**枚举出来的，
  // 表后来加了列（如 transactions.channel），旧触发器就不会再捕获该列的改动 —— 同步静默漏掉。
  // 所以这里比内容：期望 SQL 用当前列现算，和库里存的原文归一化后对比。
  const stored = (nm) => db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(nm)?.sql ?? null
  const expect = { ins: trigInsert(t), upd: trigUpdate(t, cols), del: trigDelete(t) }
  const state = (e, s) => (s == null ? '缺' : normSql(e) === normSql(s) ? '最新' : '旧')
  tables.push({
    t, cols, n, expect,
    st: {
      ins: state(expect.ins, stored(`trg_${t}_ins`)),
      upd: state(expect.upd, stored(`trg_${t}_upd`)),
      del: state(expect.del, stored(`trg_${t}_del`)),
    },
  })
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
const MARK = { 最新: '   最新   ', 旧: ' 过旧→重建 ', 缺: ' 缺失→新建 ' }
const tally = { 最新: 0, 旧: 0, 缺: 0 }
for (const r of tables) {
  for (const k of ['ins', 'upd', 'del']) tally[r.st[k]]++
  console.log(r.t.padEnd(22) + String(r.n).padStart(7) + '   ' +
    MARK[r.st.ins] + MARK[r.st.upd] + MARK[r.st.del])
}
console.log('-'.repeat(78))
const staleUpd = tables.filter((r) => r.st.upd === '旧').map((r) => r.t)
const dirtyTables = tables.filter((r) => ['ins', 'upd', 'del'].some((x) => r.st[x] !== '最新'))
console.log(`共 ${tables.length} 张表；触发器 ${tables.length * 3} 个 —— 最新 ${tally['最新']} / 过旧→重建 ${tally['旧']} / 缺失→新建 ${tally['缺']}`)
console.log(`需要动一动的表: ${dirtyTables.length} 张`)
if (staleUpd.length) console.log(`  · upd 触发器因表加过列而过旧（不同步该列改动）: ${staleUpd.join(', ')}`)

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
// 优先 VACUUM INTO：直接 copyFileSync 活库会漏掉尚未 checkpoint 的 WAL，拷出来不能当退路
let backupHow = 'VACUUM INTO（在线一致快照）'
try {
  db.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'")
} catch (e) {
  backupHow = 'copyFileSync 回退（VACUUM INTO 失败：' + e.message + '）'
  fs.copyFileSync(DB, backup)
}
console.log('\n已整库备份: ' + backup)
console.log('  方式: ' + backupHow + '，大小 ' + fs.statSync(backup).size + ' 字节')
try {
  const bdb = new DatabaseSync(backup, { readOnly: true })
  const icv = Object.values(bdb.prepare('PRAGMA integrity_check').get())[0]
  const bt = bdb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
  const st = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
  bdb.close()
  console.log('  自证: integrity_check=' + icv + '，表 ' + bt + '/' + st)
  if (icv !== 'ok' || bt !== st) { console.error('\n拒绝执行：备份与源库不一致，不能拿它当退路。'); process.exit(1) }
} catch (e) {
  console.error('\n拒绝执行：备份打开失败（' + e.message + '）'); process.exit(1)
}

db.exec('BEGIN IMMEDIATE')
try {
  db.exec(CHANGELOG_DDL)
  db.exec(IDX_DDL)
  console.log('  已建 sync_changelog + 索引')
  let made = 0, kept = 0
  for (const r of tables) {
    for (const [k, name] of [['ins', `trg_${r.t}_ins`], ['upd', `trg_${r.t}_upd`], ['del', `trg_${r.t}_del`]]) {
      if (r.st[k] === '最新') { kept++; continue }
      // 必须先 DROP：SQLite 没有 CREATE OR REPLACE TRIGGER，而带上 IF NOT EXISTS
      // 就正是上面那个"表加了列、触发器却永远不更新"的坑，这里绝不能再带。
      db.exec(`DROP TRIGGER IF EXISTS "${name}"`)
      db.exec(r.expect[k])
      made++
    }
  }
  console.log(`  触发器：重建 ${made} 个，内容已是最新跳过 ${kept} 个`)

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