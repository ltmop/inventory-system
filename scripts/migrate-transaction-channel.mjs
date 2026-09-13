#!/usr/bin/env node
/**
 * 给 transactions 补 channel（销售渠道）列 —— 首单北极星判据的前置。
 *
 * 背景（2026-09-12 核实）：
 *   台账 line 25 的首单判据是 `type=out 且 amount>0 且 渠道=Shopee`，
 *   并自带一句「若库内无渠道字段则本判据不成立，需先补字段，不得用 amount>0 顶替」。
 *   实测：全库 27/28 张表**没有任何销售渠道列** → 判据不成立，本脚本补上这个字段。
 *
 * 为什么必须补、且为什么不能拿 amount>0 顶替（实测证据）：
 *   中央库唯一一行 selling_price>0 是 id=309 —— ¥7.50、pay_method=现金、operator=店长、
 *   2026-09-11T21:00。**那是线下现金零售，不是 Shopee**。若判据去掉渠道条件，这行今天就满足，
 *   北极星会被标成「首单已出」—— 台账警告的正是这件事。
 *
 * 设计（沿用本仓库既有的「触发器兜底」约定，见 migrate-sync-changelog.mjs 的注释）：
 *   1) 加列 `channel TEXT`，**不给 DDL 默认值** —— 避免把 type='in'（入库）也标成渠道。
 *   2) 建 AFTER INSERT 触发器：**type='out' 且 channel 为空 → 默认 '线下'**。
 *      transactions 的写入点有 14 处，逐个改既漏又危险；触发器一处不漏、app 代码零改动。
 *      默认值是「线下」= 产品定的口径；**Shopee 必须由调用方显式写入**，绝不自动推断。
 *   3) 历史回填**只做有证据的分类，不编造**：
 *        · operator 以「优选仓」开头的 out 行 → '优选仓'（operator 字面就写着优选仓发货）
 *        · 其余 out 行（如 id=309 现金/店长）→ '线下'（产品定的默认）
 *        · type='in' 行 → 保持 NULL（渠道对入库不适用）
 *
 * 用法：
 *   node scripts/migrate-transaction-channel.mjs                     # 只读盘点（默认）
 *   node scripts/migrate-transaction-channel.mjs --plan              # 打印将执行的 DDL 与回填统计
 *   node scripts/migrate-transaction-channel.mjs --apply --yes       # 执行（先整库备份；请先关闭客户端）
 *   node scripts/migrate-transaction-channel.mjs --db <path> ...     # 指定库文件
 *
 * ⚠️ 执行完请接着跑一次 `node scripts/migrate-sync-changelog.mjs --apply --yes`：
 *    同步触发器是在建表时按当时的列生成的，新增 channel 列不在它的比对列里，
 *    不重跑的话「只改渠道」这种变更不会进 sync_changelog（多端同步会漏）。本脚本会在结尾提醒。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
// 口径单一事实源：库表触发器（db.js）、开单校验（commands/outbound.js）、断言（test-backend.mjs）
// 与迁移脚本都从 electron/channels.js 取，避免四处各写一份取值集合后走偏
import { CHANNELS, DEFAULT_CHANNEL } from '../electron/channels.js'

const argv = process.argv.slice(2)
const PLAN = argv.includes('--plan')
const APPLY = argv.includes('--apply')
const YES = argv.includes('--yes')
const dbArgIdx = argv.indexOf('--db')
const DB = dbArgIdx >= 0 && argv[dbArgIdx + 1]
  ? path.resolve(argv[dbArgIdx + 1])
  : path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'fishing-inventory', 'data.db')

// 渠道取值集合（产品 2026-09-12 定：默认线下；Shopee 必须显式写）
export { CHANNELS }

if (!fs.existsSync(DB)) { console.error('找不到库文件：' + DB); process.exit(1) }

const ALTER_DDL = 'ALTER TABLE transactions ADD COLUMN channel TEXT'
const TRIGGER_DDL =
  'CREATE TRIGGER IF NOT EXISTS trg_transactions_channel_default\n' +
  'AFTER INSERT ON transactions\n' +
  'BEGIN\n' +
  "  UPDATE transactions SET channel = '" + DEFAULT_CHANNEL + "'\n" +
  "   WHERE rowid = NEW.rowid AND type = 'out' AND (channel IS NULL OR channel = '');\n" +
  'END'

const db = new DatabaseSync(DB)
const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name)
const hasCol = cols.includes('channel')
const hasTrg = !!db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_transactions_channel_default'").get()

// 回填目标统计（只读）
const bfPref = db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out' AND operator LIKE '优选仓%'").get().n
const bfOut = db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out'").get().n
const bfIn = db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='in'").get().n

console.log('库文件      : ' + DB)
console.log('transactions 行数 : ' + db.prepare('SELECT COUNT(*) n FROM transactions').get().n)
console.log('已有 channel 列   : ' + (hasCol ? '是' : '否（将新增）'))
console.log('已有默认触发器    : ' + (hasTrg ? '是' : '否（将创建）'))
console.log('')
console.log('历史回填计划（只做有证据的分类）：')
console.log('  operator 以「优选仓」开头的 out 行 → 「优选仓」 : ' + bfPref + ' 行')
console.log('  其余 out 行                       → 「线下」   : ' + (bfOut - bfPref) + ' 行')
console.log('  type=in 行                        → 保持 NULL  : ' + bfIn + ' 行（渠道对入库不适用）')

if (PLAN && !APPLY) {
  console.log('\n--- 将要执行的 DDL ---')
  console.log(ALTER_DDL + ';')
  console.log(TRIGGER_DDL + ';')
  console.log("-- 回填：UPDATE transactions SET channel='优选仓' WHERE type='out' AND operator LIKE '优选仓%' AND channel IS NULL;")
  console.log("-- 回填：UPDATE transactions SET channel='线下'   WHERE type='out' AND channel IS NULL;")
}

if (!APPLY) {
  db.close()
  console.log('\n（只读盘点结束，未改动任何数据。执行请加 --apply --yes，并先关闭客户端）')
  process.exit(0)
}

// ---------- 执行 ----------
if (!YES) { console.error('\n拒绝执行：--apply 必须同时带 --yes（且请先关闭客户端）'); process.exit(2) }

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = DB + '.bak-preplacechannel-' + stamp
// 优先 VACUUM INTO：对**活库**做在线一致快照。直接 copyFileSync 拷 WAL 库拿到的是
// 「主库文件 + 尚未 checkpoint 的 WAL」，拷出来可能缺最近事务、甚至在事务中途，不能当备份用。
let backupHow = 'VACUUM INTO（在线一致快照）'
try {
  db.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'")
} catch (e) {
  backupHow = 'copyFileSync 回退（VACUUM INTO 失败：' + e.message + '）—— 请确认客户端已关闭'
  fs.copyFileSync(DB, backup)
}
const bkSize = fs.statSync(backup).size
console.log('\n已整库备份: ' + backup)
console.log('  方式: ' + backupHow)
console.log('  大小: ' + bkSize + ' 字节')

// 备份可信度自证：能独立打开、integrity_check 通过、表数一致 —— 否则宁可不改
try {
  const bdb = new DatabaseSync(backup, { readOnly: true })
  const ic = bdb.prepare('PRAGMA integrity_check').get()
  const icv = Object.values(ic)[0]
  const bt = bdb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
  const st = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
  const bc = bdb.prepare('SELECT COUNT(*) n FROM transactions').get().n
  const sc = db.prepare('SELECT COUNT(*) n FROM transactions').get().n
  bdb.close()
  console.log('  自证: integrity_check=' + icv + '，表 ' + bt + '/' + st + '，transactions ' + bc + '/' + sc + ' 行')
  if (icv !== 'ok' || bt !== st || bc !== sc) {
    console.error('\n拒绝执行：备份与源库不一致，不能拿它当退路。');
    process.exit(1)
  }
} catch (e) {
  console.error('\n拒绝执行：备份打开失败（' + e.message + '），不能拿它当退路。')
  process.exit(1)
}

db.exec('BEGIN IMMEDIATE')
try {
  if (!hasCol) { db.exec(ALTER_DDL); console.log('  已加列 transactions.channel') }
  else { console.log('  channel 列已存在，跳过') }
  db.exec(TRIGGER_DDL)
  console.log('  已建默认触发器 trg_transactions_channel_default（out 行空渠道 → ' + DEFAULT_CHANNEL + '）')

  const r1 = db.prepare("UPDATE transactions SET channel='优选仓' WHERE type='out' AND operator LIKE '优选仓%' AND channel IS NULL").run()
  const r2 = db.prepare("UPDATE transactions SET channel='线下' WHERE type='out' AND channel IS NULL").run()
  console.log('  回填 优选仓: ' + r1.changes + ' 行')
  console.log('  回填 线下  : ' + r2.changes + ' 行')

  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK')
  console.error('失败已回滚：' + e.message)
  process.exit(1)
}

// 执行后自证
const dist = db.prepare("SELECT COALESCE(channel,'(NULL)') c, type, COUNT(*) n FROM transactions GROUP BY c, type ORDER BY n DESC").all()
console.log('\n执行后渠道分布：')
for (const r of dist) console.log('  ' + String(r.c).padEnd(10) + ' type=' + String(r.type).padEnd(4) + ' → ' + r.n + ' 行')

// 首单判据预演（这正是台账 line 25 的那条）
const shopee = db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out' AND channel='Shopee' AND selling_price > 0").get().n
const wouldFalsePositive = db.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out' AND selling_price > 0").get().n
console.log('\n首单判据预演：')
console.log('  `type=out 且 selling_price>0 且 channel=Shopee` → ' + shopee + ' 行  ' + (shopee === 0 ? '（首单未出，与台账一致）' : '（首单已出！）'))
console.log('  若去掉渠道条件 `type=out 且 selling_price>0`   → ' + wouldFalsePositive + ' 行  ← 这正是「不得用 amount>0 顶替」要挡的')
console.log('\n⚠️ 请接着跑一次 node scripts/migrate-sync-changelog.mjs --apply --yes，让同步触发器带上新列 channel。')
db.close()
