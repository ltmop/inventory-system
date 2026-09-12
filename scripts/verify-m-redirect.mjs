// verify-m-redirect.mjs —— 方案 1 验收：/m（无斜杠）必须 308 跳到 /m/，且**保留 ?token=**。
//
// 这一段为什么要做（一句话）：electron/mobile/index.html 用相对路径是**设计意图**
// （官网 /m/sw.js 的 BASE=/m/，APK /sw.js 的 BASE=/，同一份代码两端通吃），
// 但浏览器在 /m（无斜杠）下会把相对路径解析到根目录 → app.js 变 /app.js → 404 → 白屏。
//
// 真起服务器、真发 HTTP，**不跟重定向看状态码**，再**手动跟随**验端到端。
// 跑法（仓库根目录）：node scripts/verify-m-redirect.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../electron/db.js'
import { createInventoryServer } from '../electron/server.js'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); return }
  fail++; failures.push(name)
  console.log('  ✗ ' + name + (extra !== undefined ? '\n      → ' + extra : ''))
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log('  ✓ ' + name); return }
  fail++; failures.push(name)
  console.log('  ✗ ' + name + '\n      期望: ' + e + '\n      实际: ' + a)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm-redirect-'))
const db = openDatabase(path.join(tmp, 'm.db'))
const dataDir = path.join(tmp, 'data')
const srv = createInventoryServer({ db, dataDir, basePort: 0 })
const st = await srv.start()
const base = 'http://127.0.0.1:' + st.port
const token = fs.readFileSync(path.join(dataDir, 'server-token.txt'), 'utf8').trim()
console.log('测试服务器: ' + base)
console.log('')

// ── 1) /m 无斜杠 → 308，Location 指向 /m/
const r1 = await fetch(base + '/m', { redirect: 'manual' })
eq('/m 返回 308', r1.status, 308)
eq('/m 的 Location 是 /m/', r1.headers.get('location'), '/m/')

// ── 2) 必须保留 ?token=（店里二维码是 /m/?token=xxx，丢了就白跳 + 401）
const r2 = await fetch(base + '/m?token=' + token, { redirect: 'manual' })
eq('/m?token=xxx 返回 308', r2.status, 308)
eq('/m?token=xxx 的 Location 完整保留了 query', r2.headers.get('location'), '/m/?token=' + token)

// ── 3) 手动跟随重定向，验端到端真能拿到页面（不是只看状态码）
const follow = await fetch(base + '/m?token=' + token, { redirect: 'follow' })
eq('跟随 /m?token=xxx 后 → 200', follow.status, 200)
const html = await follow.text()
ok('跟随后的页面是手机端 index.html（引用了 app.js）', html.includes('app.js'), html.slice(0, 100))
ok('跟随后的页面引用了 offline.js（A3 离线层已接线）', html.includes('offline.js'))

// ── 4) 证明「为什么必须有这个重定向」：相对路径在根目录确实是 404
const appJs = await fetch(base + '/m/app.js', { redirect: 'manual' })
eq('/m/app.js → 200（资源都在 /m/ 下）', appJs.status, 200)
const rootAppJs = await fetch(base + '/app.js', { redirect: 'manual' })
eq('/app.js → 404（所以 /m 无斜杠必然白屏，这就是本方案存在的原因）', rootAppJs.status, 404)

// ── 5) 回归：其他路径不该被我的改动重定向（唯一新增的 308 只属于 /m）
console.log('')
for (const p of ['/m/', '/m/index.html', '/m/app.js', '/m/offline.js', '/m/sw.js', '/m/manifest.json', '/']) {
  const r = await fetch(base + p, { redirect: 'manual' })
  ok(p + ' 不会被误重定向（非 308）', r.status !== 308, 'status=' + r.status)
}
const mSlash = await fetch(base + '/m/', { redirect: 'manual' })
eq('/m/ 仍是 200（老书签/直接带斜杠的访问不受影响）', mSlash.status, 200)

await srv.stop()
db.close()
fs.rmSync(tmp, { recursive: true, force: true })

console.log('')
if (fail === 0) {
  console.log('全部 ' + pass + ' 项断言通过')
  process.exit(0)
}
console.log('✗ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项')
for (const n of failures) console.log('   - ' + n)
process.exit(1)
