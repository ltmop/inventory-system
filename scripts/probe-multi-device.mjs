// 多设备并发探针（2026-09-15）
// 回答一个具体问题：一个店铺，2~3 台手机 + 1 台电脑同时开单，会不会超卖 / 重复记账 / 谁看不到谁？
// 做法：临时库 + 真 HTTP 服务实例（与生产同一份 server.js / commands），并发打请求，断言服务端裁决结果。
// 用法：node scripts/probe-multi-device.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../electron/db.js'
import * as cmd from '../electron/commands.js'
import { createInventoryServer } from '../electron/server.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-multi-'))
const db = openDatabase(path.join(tmp, 'data.db'))
const srv = createInventoryServer({ db, dataDir: path.join(tmp, 'srv'), basePort: 0 })
const st = await srv.start()
const base = 'http://127.0.0.1:' + st.port
const token = fs.readFileSync(path.join(tmp, 'srv', 'server-token.txt'), 'utf8').trim()
const viewToken = fs.readFileSync(path.join(tmp, 'srv', 'server-view-token.txt'), 'utf8').trim()

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail ? '   [' + detail + ']' : ''))
  cond ? pass++ : fail++
}
const call = async (channel, payload, tk) => {
  const r = await fetch(base + '/api/invoke?token=' + (tk || token), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, payload }),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const stockOf = (id) => db.prepare('SELECT COALESCE(SUM(quantity),0) q FROM inventory_batches WHERE product_id = ?').get(id).q
const outN = (id) => db.prepare("SELECT COUNT(*) n FROM transactions WHERE product_id = ? AND type='out'").get(id).n

// ---- 建一个只有 1 件的商品（模拟「最后一件」）----
const p1 = cmd.createProduct(db, { sku_code: 'MD-1', category: '测试', brand: '并发', model: '最后一件', cost_price: 100, suggest_price: 200, location: 'A', status: '待盘点' })
cmd.createInbound(db, { productId: p1.id, quantity: 1, costPrice: 100, location: 'A', operator: '店主' })
const one = { items: [{ productId: p1.id, quantity: 1, sellingPrice: 200 }], payMethod: '现金' }

console.log('\n【场景 A】2 台手机 + 1 台电脑，同时抢卖最后 1 件（3 个不同幂等键）')
const rA = await Promise.all([
  call('outbound:checkout', { ...one, operator: '手机A', idempotencyKey: 'A-' + Date.now() }),
  call('outbound:checkout', { ...one, operator: '手机B', idempotencyKey: 'B-' + Date.now() }),
  call('outbound:checkout', { ...one, operator: '电脑', idempotencyKey: 'C-' + Date.now() }),
])
const sold = rA.filter((r) => r.body?.result?.ok !== false)
const blocked = rA.filter((r) => r.body?.result?.ok === false)
ok('只有 1 单成交（不超卖）', sold.length === 1, '成交 ' + sold.length + ' 单')
ok('其余被明确拦截并给中文原因', blocked.length === 2 && blocked.every((r) => (r.body.result.shortages || []).length > 0),
  blocked.map((r) => JSON.stringify(r.body.result.shortages)).join(' '))
ok('库存落到 0，没有变负', stockOf(p1.id) === 0, '库存=' + stockOf(p1.id))
ok('出库流水只多 1 条', outN(p1.id) === 1, '流水=' + outN(p1.id) + ' 条')

console.log('\n【场景 B】同一台手机弱网重试：同 1 个幂等键并发打 5 次')
const p2 = cmd.createProduct(db, { sku_code: 'MD-2', category: '测试', brand: '并发', model: '重试', cost_price: 100, suggest_price: 200, location: 'A', status: '待盘点' })
cmd.createInbound(db, { productId: p2.id, quantity: 10, costPrice: 100, location: 'A', operator: '店主' })
const key = 'retry-' + Date.now()
const rB = await Promise.all(Array.from({ length: 5 }, () => call('outbound:checkout', { items: [{ productId: p2.id, quantity: 2, sellingPrice: 200 }], payMethod: '现金', operator: '手机A', idempotencyKey: key })))
const realWrites = outN(p2.id)
ok('只落 1 笔流水（重试不重复记账）', realWrites === 1, '流水=' + realWrites + ' 条')
ok('只扣 1 次库存（10 → 8）', stockOf(p2.id) === 8, '库存=' + stockOf(p2.id))
ok('重复请求被标记 idempotent 并回原结果', rB.filter((r) => r.body?.idempotent === true).length === 4,
  'idempotent ' + rB.filter((r) => r.body?.idempotent === true).length + '/5')

console.log('\n【场景 C】同一本账：A 设备刚写完，B 设备立刻读得到')
const read = await call('product:list', { keyword: 'MD-2', limit: 5 })
const row = (read.body?.result || []).find((x) => x.id === p2.id)
ok('B 设备立刻读到最新库存', !!row && row.total_stock === 8, row ? 'total_stock=' + row.total_stock : '没读到')

console.log('\n【场景 D】权限：财务只读码开单必须被拒')
const rD = await call('outbound:checkout', { ...one, operator: '财务', idempotencyKey: 'D-' + Date.now() }, viewToken)
ok('只读码写操作 403', rD.status === 403, 'HTTP ' + rD.status + ' ' + (rD.body?.error || ''))

console.log('\n【场景 E】5 台设备各买 1 件（库存 5）：应该全部成交、库存归零')
const p3 = cmd.createProduct(db, { sku_code: 'MD-3', category: '测试', brand: '并发', model: '够卖', cost_price: 100, suggest_price: 200, location: 'A', status: '待盘点' })
cmd.createInbound(db, { productId: p3.id, quantity: 5, costPrice: 100, location: 'A', operator: '店主' })
const rE = await Promise.all(Array.from({ length: 5 }, (_, i) => call('outbound:checkout', { items: [{ productId: p3.id, quantity: 1, sellingPrice: 200 }], payMethod: '现金', operator: '设备' + i, idempotencyKey: 'E' + i + '-' + Date.now() })))
ok('5 单全部成交', rE.filter((r) => r.body?.result?.ok !== false).length === 5, '成交 ' + rE.filter((r) => r.body?.result?.ok !== false).length + '/5')
ok('库存归零不变负', stockOf(p3.id) === 0, '库存=' + stockOf(p3.id))
ok('流水正好 5 条', outN(p3.id) === 5, '流水=' + outN(p3.id) + ' 条')

await srv.stop()
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
