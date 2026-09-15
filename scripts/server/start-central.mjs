// 中央库服务器启动脚本（pm2 进程 inventory-app 的入口）
//
// ⚠️ 这份文件**只存在于仓库这一处 + 服务器 /opt/inventory-app/start-central.mjs**。
//    2026-09-15 之前它只有服务器上有（仓库里没有）→ 属"幽灵文件"：改了没记录、换机器就断线索。
//    现在收进仓库；部署时 scp 到 /opt/inventory-app/start-central.mjs。
//
// 跑法（pm2 配置里就是这样起的）：
//   /opt/node22/bin/node --experimental-sqlite /opt/inventory-app/start-central.mjs
import path from 'node:path'
import fs from 'node:fs'
import { openDatabase } from './electron/db.js'

// 跨域：手机 APP 跑在 http://localhost，接口打本域属跨基；Caddy 未加 CORS（已核实），
// 所以在这里显式放行。必须放在 import server.js **之前** —— server.js 在模块加载时读取该变量，
// 而静态 import 会先于本文件任何语句执行，故改用动态 import。
process.env.FI_CORS_ALLOW_ORIGINS ||= 'http://localhost,https://app.junchengzn.com'
const { createInventoryServer } = await import('./electron/server.js')

const APP = '/opt/inventory-app'
const dataDir = path.join(APP, 'data')
fs.mkdirSync(dataDir, { recursive: true })
const db = openDatabase(path.join(dataDir, 'data.db'))
console.log('central db opened, products:', db.prepare('SELECT COUNT(*) n FROM products').get().n)
const srv = createInventoryServer({ db, dataDir, basePort: 3200, webRoot: path.join(APP, 'dist') })
const st = await srv.start()
// ⚠️ 不要把 st.url 原样打出来：它形如 https://ip:3201/?token=<32位随机>。
//    pm2 的 out.log 会长期留在服务器上 —— 明文 token 等于把中心库钥匙写进日志（红线⑤：生产密钥零明文）。
//    2026-09-15 实测踩到：日志里确实躺着一个明文 token。这里只打端口和脱敏后的地址。
const maskedUrl = typeof st.url === 'string' ? st.url.replace(/token=[^&]+/, 'token=***') : st.url
console.log('central app on', st.port, maskedUrl)
