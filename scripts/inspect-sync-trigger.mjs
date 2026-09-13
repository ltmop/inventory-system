// 查 sync_changelog 触发器原文，确认新加的 channel 列是否被同步带上。
// 跑法：node scripts/_inspect-sync-trigger.mjs
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'

const DB = process.argv[2] || path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'fishing-inventory', 'data.db',
)
const db = new DatabaseSync(DB, { readOnly: true })
const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='transactions' ORDER BY name").all()
console.log('库: ' + DB)
console.log('transactions 触发器数量: ' + rows.length)
for (const r of rows) {
  const hasChannel = /channel/i.test(r.sql ?? '')
  console.log('\n--- ' + r.name + '  channel 命中: ' + (hasChannel ? '是' : '否') + ' ---')
  console.log(r.sql)
}
db.close()
