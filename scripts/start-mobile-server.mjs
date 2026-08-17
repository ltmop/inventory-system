// 启动手机端局域网服务（诊断用）：node scripts/start-mobile-server.mjs
import os from 'node:os'
import path from 'node:path'
import { createInventoryServer } from '../electron/server.js'
import { openDatabase } from '../electron/db.js'

const port = parseInt(process.env.PORT || '18400', 10)
const tmpDb = path.join(os.tmpdir(), 'fi-mobile-server.db')
const db = openDatabase(tmpDb)
// webRoot 指向 dist，让 /app 也能服务桌面版（诊断 PoC 用）
const server = createInventoryServer({ db, dataDir: os.tmpdir(), basePort: port, webRoot: path.resolve('dist') })
await server.start()
console.log('手机端服务已启动，请访问 http://127.0.0.1:' + port + '/m/?token=test')
