// 后端命令层单测：不依赖 Electron，直接用 Node 24 的 node:sqlite 跑
// 覆盖：种子数据 / 入库 / FIFO 跨批次出库 / 超库存拒绝 / 盘点闭环 / 供应商删除 / 断电恢复
//       / 赊账包（客户余额模型：客户 CRUD、赊销/还款/预收、对账单、退货冲减）
//       / SKU 简化（条码即 SKU、无条码 1001 递增）/ 盘点按品类/供应商筛选
//       / 采购订单（建单→部分收货→收齐完成/取消/超订拒绝/原子性）/ 多级定价（档次价设删查 + 出库接入）
//       / 客户价格档（建改查/非法拒绝/老库迁移）/ 换货差价（补差价/退差价/赊账口径/原子性）
//       / 手机写接口（POST /api/outbound 全链路 + 安全加固 + 只读端点不回退）
//       / 备份增强（backupStatus/第二位置复制/失败降级/stale 判定）
//       / 收款方式（出库/退货 pay_method 落库与校验、纯赊强制落空、todayPaymentSplit 日结拆分、手机端透传）
//       / 过期预警（临期/已过期/零库存不出现/无保质期不出现/YYYY-MM 写法）
//       / 分级库存预警（min_stock 设改清/NULL 回退默认阈值/低库存口径/老库迁移）
//       / 操作日志（各写命令埋点/同事务回滚/查询筛选）
//       / 供应商对账（明细+汇总+待收采购单金额）/ 手机端 /api/audit 与 /api/supplier-statement
//       / 商品图片（photo.js 写入/覆盖清旧/路径穿越拒绝、updateProduct photo_path、手机端 /api/photo）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, finalCheckpoint } from '../electron/db.js'
import * as cmd from '../electron/commands.js'
import { backupNow, restoreBackup, backupStatus, saveBackupExtraDir, loadBackupConfig } from '../electron/backup.js'
import { SEED_PRODUCTS, SEED_BATCHES, SEED_TRANSACTIONS } from '../electron/seedData.js'
import { localFuzzyMatch } from '../electron/localSearch.js'
import { logAudit } from '../electron/commands/helpers.js'
// analytics 不在 commands.js 桶文件里（server.js 也是直接 import 这个模块）→ 这里照样直接引
import { analyticsOverview, analyticsTrend, analyticsTop } from '../electron/commands/analytics.js'
// 通道闸门（2026-09-21）：发布侧（build-web-bundle.mjs 第 ④ 步）与客户端用的是同一套判据，这里也用它，
// 把"发版时才发现"提前成"提交时就红"。见文件末尾那条断言。
import { channelsUsedInSrc } from './lib/channels.mjs'
import { readSupportedChannels } from '../electron/webUpdate.js'
// 中心库配置的主进程事实源（P0 2026-09-15）：纯 Node、不 import electron，可直接单测
import { initCentralConfig, getCentralConfigLocal, setCentralConfigLocal, isCentralConfigured } from '../electron/centralConfig.js'
// 功能开关（P3）：出厂默认 + 本机文件 + 服务端下发；"关"永远压过"开"
import * as flags from '../electron/flags.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-test-'))
const dbPath = path.join(tmp, 'data.db')
let passed = 0
const ok = (name, cond) => {
  if (!cond) {
    console.error(`✗ ${name}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${name}`)
}

// 1. 初始化 + 种子
const db = openDatabase(dbPath)
const all = cmd.loadAll(db)
ok('种子数据：12 个通用演示商品', all.products.length === 12)
ok('种子数据：12 个批次', all.batches.length === 12)
ok('种子数据：20 条流水（含 90 天前历史 + return/exchange）', all.transactions.length === 20)
ok('种子含退货流水', all.transactions.some((t) => t.type === 'return'))
ok(
  '种子含换货流水（return/out 双腿记账）',
  all.transactions.some((t) => t.notes === '换货退旧' && t.type === 'return') &&
    all.transactions.some((t) => t.notes === '换货出新' && t.type === 'out'),
)
ok(
  '种子含 90 天前流水',
  all.transactions.some((t) => Date.now() - new Date(t.timestamp).getTime() > 89 * 24 * 3600 * 1000),
)
ok('WAL 模式已开启', db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal')

// 2. 新建商品 + 入库
const p = cmd.createProduct(db, {
  sku_code: 'JD-T-999', barcode: '6900000000001', category: '工具配件',
  brand: '测试品牌', model: '测试型号', cost_price: 1000, suggest_price: 2000,
  location: 'Z区', status: '待盘点',
})
ok('新建商品返回完整行', p.id > 0 && p.sku_code === 'JD-T-999')

// 2b. sku_code 留空 → 新规则：有条码直接用条码；无条码纯数字编号从 1001 递增
const pAuto = cmd.createProduct(db, {
  sku_code: '', barcode: null, category: '工具配件', sub_category: '剪刀',
  brand: '测试品牌', model: null, cost_price: 500, suggest_price: null,
  location: null, status: '待盘点',
})
ok('SKU 留空无条码自动编 1001', pAuto.sku_code === '1001')
const pAuto2 = cmd.createProduct(db, {
  sku_code: '', barcode: null, category: '工具配件', sub_category: '剪刀',
  brand: '测试品牌', model: null, cost_price: 500, suggest_price: null,
  location: null, status: '待盘点',
})
ok('自动数字 SKU 递增', pAuto2.sku_code === '1002')
// 有条码时 SKU 直接用条码（扫码枪扫出来就是它）
const pBar = cmd.createProduct(db, {
  sku_code: '', barcode: '6901234567890', category: '工具配件', sub_category: null,
  brand: '条码牌', model: null, cost_price: 500, suggest_price: null,
  location: null, status: '待盘点',
})
ok('有条码时 SKU 直接用条码', pBar.sku_code === '6901234567890')
// 条码是纯数字但不占 1001 序列（EAN-13 是 13 位，被排除在数字编号之外）
const pAuto3 = cmd.createProduct(db, {
  sku_code: '', barcode: null, category: '工具配件', sub_category: null,
  brand: '测试品牌', model: null, cost_price: 500, suggest_price: null,
  location: null, status: '待盘点',
})
ok('条码 SKU 不占数字编号序列', pAuto3.sku_code === '1003')
// 条码与其他商品 SKU 撞车要报中文错，而不是裸 UNIQUE 约束错误
let barDupErr = null
try {
  cmd.createProduct(db, { sku_code: '', barcode: 'JD-T-999', category: '工具配件', cost_price: 100 })
} catch (e) {
  barDupErr = e
}
ok('条码与已有 SKU 冲突报中文错', barDupErr !== null && barDupErr.message.includes('条码'))
// 种子 SKU 不受影响，继续原样使用
ok('种子 SKU 原样保留', db.prepare('SELECT sku_code FROM products WHERE id = 1').get().sku_code === 'SP-001')

// 2c. updateProduct：部分字段合并更新，SKU 不可变
const pUpd = cmd.updateProduct(db, pAuto.id, { model: '改后的型号', sku_code: 'HACK' })
ok('updateProduct 部分更新生效', pUpd.model === '改后的型号' && pUpd.category === '工具配件')
ok('updateProduct 不可改 SKU', pUpd.sku_code === pAuto.sku_code)

// 2e. 渔具规格字段：建/改/读回 + 空串转 NULL + 不传默认 NULL
const pRod = cmd.createProduct(db, {
  sku_code: '', barcode: null, category: '鱼竿', sub_category: '手竿',
  brand: '汉鼎', model: '一号', cost_price: 4500, suggest_price: 8500,
  location: null, status: '待盘点',
  rod_length: '3.6m', rod_action: '28调', power_rating: 'H', color: '', material: null,
})
ok('新建商品规格字段落库', pRod.rod_length === '3.6m' && pRod.rod_action === '28调' && pRod.power_rating === 'H')
ok('规格空字符串落 NULL', pRod.color === null && pRod.material === null)
ok('未传规格字段默认 NULL', pRod.line_number === null && pRod.hook_size === null && pRod.expiry_date === null)
const pRodUpd = cmd.updateProduct(db, pRod.id, { rod_length: ' 4.5m ', color: '黑' })
ok('updateProduct 更新规格字段并去空白', pRodUpd.rod_length === '4.5m' && pRodUpd.color === '黑')
ok('updateProduct 未传的规格字段保持原值', pRodUpd.rod_action === '28调' && pRodUpd.power_rating === 'H')
const pRodClear = cmd.updateProduct(db, pRod.id, { rod_length: '' })
ok('updateProduct 规格空串清为 NULL', pRodClear.rod_length === null)
// 老商品（种子数据，建库时无规格）不受影响
ok('种子老商品规格字段全 NULL', all.products.every((sp) => sp.rod_length === null && sp.color === null && sp.expiry_date === null))
// 批量导入透传规格字段
const impSpec = cmd.importBatch(db, {
  rows: [
    { sku_code: 'IMP-SPEC-1', category: '鱼钩', quantity: 10, cost_price: 300, hook_size: '伊势尼5号', material: '高碳钢', color: '' },
    { sku_code: 'IMP-SPEC-2', category: '饵料', quantity: 20, cost_price: 500, expiry_date: '2027-06', color: '腥香' },
  ],
})
ok('批量导入规格字段成功', impSpec.imported === 2)
const impHook = db.prepare('SELECT * FROM products WHERE sku_code = ?').get('IMP-SPEC-1')
ok('批量导入规格字段落库', impHook.hook_size === '伊势尼5号' && impHook.material === '高碳钢' && impHook.color === null)
const impBait = db.prepare('SELECT * FROM products WHERE sku_code = ?').get('IMP-SPEC-2')
ok('批量导入保质期落库', impBait.expiry_date === '2027-06' && impBait.color === '腥香')

// 2d. deleteProduct：无记录商品可删，有批次/流水的拒绝
const delFresh = cmd.deleteProduct(db, pAuto2.id)
ok('无记录商品可删除', delFresh.ok === true)
cmd.createInbound(db, { productId: pAuto.id, quantity: 1, costPrice: 500, location: null, supplierId: null, operator: '测试' })
const delBlocked = cmd.deleteProduct(db, pAuto.id)
ok('有批次商品删除被拒绝', delBlocked.ok === false && delBlocked.reason.includes('停产'))
const delGhost = cmd.deleteProduct(db, 999999)
ok('不存在商品删除返回失败', delGhost.ok === false && delGhost.reason.includes('不存在'))
const inb = cmd.createInbound(db, {
  productId: p.id, quantity: 5, costPrice: 1000, location: 'Z区', supplierId: 1, operator: '测试',
})
ok('入库生成批次号', /^PO\d{8}-\d{3}$/.test(inb.batchNo))
ok('入库后商品最近进价同步', db.prepare('SELECT cost_price FROM products WHERE id = ?').get(p.id).cost_price === 1000)

// 3. FIFO 跨批次出库：自建商品两批次 8个(4200) + 4个(4500)，出 10 → 8+2，两条流水
const pFifo = cmd.createProduct(db, { sku_code: '', barcode: null, category: '鱼竿', cost_price: 4200 })
cmd.createInbound(db, { productId: pFifo.id, quantity: 8, costPrice: 4200, location: null, supplierId: null, operator: '测试' })
cmd.createInbound(db, { productId: pFifo.id, quantity: 4, costPrice: 4500, location: null, supplierId: null, operator: '测试' })
const fifo = cmd.confirmOutbound(db, { productId: pFifo.id, quantity: 10, sellingPrice: 9000, operator: '测试' })
ok('FIFO 出库成功', fifo.ok === true)
ok('FIFO 拆成两条扣减', fifo.allocations.length === 2)
ok('先扣最早批次 8 个', fifo.allocations[0].deduct === 8 && fifo.allocations[0].remaining_after === 0)
ok('再扣次早批次 2 个', fifo.allocations[1].deduct === 2 && fifo.allocations[1].remaining_after === 2)
const outTxs = db
  .prepare("SELECT * FROM transactions WHERE product_id = ? AND type = 'out' ORDER BY id DESC LIMIT 2")
  .all(pFifo.id)
ok('出库流水记批次成本价', outTxs[0].unit_price === 4500 && outTxs[1].unit_price === 4200)
ok('出库流水记实际售价', outTxs[0].selling_price === 9000)

// 4. 超库存拒绝
const stock1 = db.prepare('SELECT SUM(quantity) AS q FROM inventory_batches WHERE product_id = 1').get().q
const over = cmd.confirmOutbound(db, { productId: 1, quantity: 999, sellingPrice: null, operator: '测试' })
ok('超库存返回 shortage', over.ok === false && over.shortage === 999 - stock1)
ok('超库存未动批次', db.prepare('SELECT quantity FROM inventory_batches WHERE id = 2').get().quantity > 0)

// 4b. 无库存强制出库（allowNoStock）：店里有货但没录库存 → 放行，超卖部分记 batch_id=null 流水
//     真实库 schema CHECK (quantity >= 0) 禁止负批次，不能建「负库存」批次——只留无批次出库流水待补录
const pNoStock = cmd.createProduct(db, { sku_code: '', barcode: null, category: '鱼线', brand: '无库存牌', model: '空库线', cost_price: 0 })
const noStock = cmd.confirmOutbound(db, { productId: pNoStock.id, quantity: 3, sellingPrice: 900, operator: '测试', allowNoStock: true })
ok('无库存强制出库返回 ok', noStock.ok === true)
ok('无库存出库记 batch_id=null 流水', db.prepare("SELECT * FROM transactions WHERE product_id = ? AND type = 'out' AND batch_id IS NULL").get(pNoStock.id) != null)
const noStockTx = db.prepare("SELECT * FROM transactions WHERE product_id = ? AND type = 'out' AND batch_id IS NULL").get(pNoStock.id)
ok('无库存出库流水数量与待补备注', noStockTx.quantity === 3 && noStockTx.notes.includes('无库存强制出库'))
ok('无库存出库不建负批次', db.prepare('SELECT COUNT(*) AS c FROM inventory_batches WHERE product_id = ?').get(pNoStock.id).c === 0)
const ckNs = cmd.confirmCheckout(db, { items: [{ productId: pNoStock.id, quantity: 2, sellingPrice: 900 }], operator: '测试', allowNoStock: true })
ok('收银台无库存强制出库 ok', ckNs.ok === true && ckNs.lines[0].allocations.some((a) => a.batch_id === null))

// 5. 盘点闭环：A墙 → 录入实盘 → 完成 → 批次库存按实盘更新
const take = cmd.createStockTake(db, { locationFilter: 'A区-饮料架', operator: '测试' })
const items = db.prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ?').all(take.id)
ok('盘点单按区域生成明细', items.length > 0 && take.status === '进行中')
const target = items[0]
cmd.updateStockTakeItem(db, { itemId: target.id, actualQty: 99, reason: '测试调整' })
cmd.completeStockTake(db, take.id)
ok('完成后批次库存按实盘数落实', db.prepare('SELECT quantity FROM inventory_batches WHERE id = ?').get(target.batch_id).quantity === 99)
ok('盘点单状态已完成', db.prepare('SELECT status FROM stock_takes WHERE id = ?').get(take.id).status === '已完成')

// 5b. 盘点原子提交（submitStockTake）：实盘数写入 + 落实批次 + 完结，同一事务
const take2 = cmd.createStockTake(db, { locationFilter: 'Z区', operator: '测试' })
const items2 = db.prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ?').all(take2.id)
ok('原子提交：盘点单已生成明细', items2.length > 0)
cmd.submitStockTake(db, {
  takeId: take2.id,
  items: items2.map((it) => ({ itemId: it.id, actualQty: it.system_qty + 3, reason: '原子提交测试' })),
})
const after2 = db.prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ?').all(take2.id)
ok(
  '原子提交：实盘数已写入明细',
  after2.every((it) => it.actual_qty === it.system_qty + 3 && it.reason === '原子提交测试'),
)
ok(
  '原子提交：批次库存按实盘落实',
  after2.every(
    (it) =>
      db.prepare('SELECT quantity FROM inventory_batches WHERE id = ?').get(it.batch_id).quantity ===
      it.system_qty + 3,
  ),
)
ok('原子提交：盘点单一次完结', db.prepare('SELECT status FROM stock_takes WHERE id = ?').get(take2.id).status === '已完成')

// 5c. 退货登记（createReturn）：加回最近批次 + 流水 type='return'
const beforeRet = db.prepare('SELECT quantity FROM inventory_batches WHERE id = ?').get(inb.batchId).quantity
const ret = cmd.createReturn(db, { productId: p.id, quantity: 2, refundPrice: 2500, operator: '测试' })
ok('退货登记成功', ret.ok === true && ret.batchId === inb.batchId)
ok(
  '退货加回最近批次',
  db.prepare('SELECT quantity FROM inventory_batches WHERE id = ?').get(inb.batchId).quantity === beforeRet + 2,
)
const retTx = db
  .prepare("SELECT * FROM transactions WHERE product_id = ? AND type = 'return' ORDER BY id DESC LIMIT 1")
  .get(p.id)
ok('退货流水类型与金额正确', retTx.type === 'return' && retTx.unit_price === 1000 && retTx.selling_price === 2500)
ok('退货流水带回补备注', retTx.notes === '退货回补')

// 5d. 退货到无批次商品：自动新建"退货回补"批次，成本取商品最近进价
const pRet = cmd.createProduct(db, {
  sku_code: '', barcode: null, category: '鱼线', sub_category: null,
  brand: '退货牌', model: null, cost_price: 800, suggest_price: null,
  location: null, status: '待盘点',
})
const ret2 = cmd.createReturn(db, { productId: pRet.id, quantity: 1, refundPrice: 1000, operator: '测试' })
const newBatch = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(ret2.batchId)
ok('无批次商品退货自动建批次', newBatch.quantity === 1 && newBatch.cost_price === 800)
// 不存在的商品必须报错而不是静默
let retErr = null
try {
  cmd.createReturn(db, { productId: 99999, quantity: 1, refundPrice: 100, operator: '测试' })
} catch (e) {
  retErr = e
}
ok('退货商品不存在时抛错', retErr !== null)

// 5e. 换货登记（createExchange）：退旧腿 type='return' + 出新腿 type='out'，同一事务
const pNew = cmd.createProduct(db, {
  sku_code: '', barcode: null, category: '浮漂', sub_category: null,
  brand: '换货牌', model: null, cost_price: 600, suggest_price: 1500,
  location: null, status: '待盘点',
})
cmd.createInbound(db, { productId: pNew.id, quantity: 3, costPrice: 600, location: null, supplierId: null, operator: '测试' })
const oldBatchBefore = db.prepare('SELECT quantity FROM inventory_batches WHERE id = ?').get(inb.batchId).quantity
const exch = cmd.createExchange(db, { oldProductId: p.id, newProductId: pNew.id, quantity: 2, sellingPrice: 1500, operator: '测试' })
ok('换货登记成功', exch.ok === true)
ok(
  '换货退旧回补旧批次',
  db.prepare('SELECT quantity FROM inventory_batches WHERE id = ?').get(inb.batchId).quantity === oldBatchBefore + 2,
)
const newBatchAfter = db
  .prepare('SELECT SUM(quantity) AS q FROM inventory_batches WHERE product_id = ?')
  .get(pNew.id).q
ok('换货出新按 FIFO 扣减', newBatchAfter === 1)
const legs = db
  .prepare("SELECT * FROM transactions WHERE notes IN ('换货退旧','换货出新') AND operator = '测试' ORDER BY id DESC LIMIT 2")
  .all()
ok('换货退旧腿记 return 类型', legs.some((t) => t.notes === '换货退旧' && t.type === 'return' && t.product_id === p.id))
ok(
  '换货出新腿记 out 类型且带售价',
  legs.some((t) => t.notes === '换货出新' && t.type === 'out' && t.product_id === pNew.id && t.selling_price === 1500),
)
// 新货不足：整体不动账
const shortage = cmd.createExchange(db, { oldProductId: p.id, newProductId: pNew.id, quantity: 99, sellingPrice: 1500, operator: '测试' })
ok('换货新货不足返回 shortage', shortage.ok === false && shortage.shortage === 98)
ok(
  '新货不足时旧批次未被回补',
  db.prepare('SELECT quantity FROM inventory_batches WHERE id = ?').get(inb.batchId).quantity === oldBatchBefore + 2,
)

// 6. 供应商删除：批次外键置空，批次保留
cmd.deleteSupplier(db, 1)
const orphan = db.prepare('SELECT COUNT(*) AS n FROM inventory_batches WHERE supplier_id = 1').get().n
ok('删除供应商后批次外键置空', orphan === 0)
ok('批次本身保留', db.prepare('SELECT COUNT(*) AS n FROM inventory_batches').get().n >= 16)

// 6b. 批量导入：重复 SKU 跳过（含文件内部重复），批次号与手动入库同规则
const imp = cmd.importBatch(db, {
  rows: [
    { sku_code: 'JC-IMP-001', barcode: null, category: '工具配件', sub_category: null, brand: '导牌', model: null, cost_price: 300, suggest_price: null, location: 'Z区', quantity: 4, operator: '测试' },
    { sku_code: 'SP-001', barcode: null, category: '饮料', sub_category: '瓶装水', brand: '农夫山泉', model: null, cost_price: 110, suggest_price: null, location: null, quantity: 1, operator: '测试' }, // 已存在
    { sku_code: 'JC-IMP-001', barcode: null, category: '工具配件', sub_category: null, brand: '导牌', model: null, cost_price: 300, suggest_price: null, location: 'Z区', quantity: 4, operator: '测试' }, // 文件内重复
  ],
})
ok('导入：新 SKU 导入 1 个', imp.imported === 1)
ok('导入：重复 SKU 跳过 2 个', imp.skipped === 2)
ok('导入批次号无 IMP 前缀', /^PO\d{8}-\d{3}$/.test(imp.results[0].batchNo))
ok('导入生成入库流水', db.prepare("SELECT COUNT(*) AS n FROM transactions t JOIN products pr ON pr.id = t.product_id WHERE t.notes = '批量导入' AND pr.sku_code = 'JC-IMP-001'").get().n === 1)

// 6c. 批量导入 SKU 新规则：与手动新建一致（显式 SKU > 条码 > 纯数字自动编号）
const maxNumBeforeImp = db
  .prepare(
    `SELECT MAX(CAST(sku_code AS INTEGER)) AS m FROM products
     WHERE sku_code <> '' AND sku_code NOT GLOB '*[^0-9]*' AND CAST(sku_code AS INTEGER) < 1000000`,
  )
  .get().m
const imp2 = cmd.importBatch(db, {
  rows: [
    { sku_code: '', barcode: '6901111222233', category: '工具配件', sub_category: null, brand: '导牌', model: null, cost_price: 300, suggest_price: null, location: null, quantity: 2, operator: '测试' },
    { sku_code: '', barcode: null, category: '工具配件', sub_category: null, brand: '导牌', model: null, cost_price: 300, suggest_price: null, location: null, quantity: 1, operator: '测试' },
    { sku_code: '', barcode: '6901111222233', category: '工具配件', sub_category: null, brand: '导牌', model: null, cost_price: 300, suggest_price: null, location: null, quantity: 2, operator: '测试' }, // 文件内重复（条码即 SKU）
  ],
})
ok('导入：条码即 SKU', imp2.results[0].sku_code === '6901111222233')
ok('导入：无条码自动数字编号', imp2.results[1].sku_code === String(maxNumBeforeImp + 1))
ok('导入：文件内条码重复跳过', imp2.imported === 2 && imp2.skipped === 1)

finalCheckpoint(db)
db.close()

// 7. 断电恢复：子进程写入后被强杀（不 checkpoint、不关闭），父进程重开验证数据在
const { pathToFileURL } = await import('node:url')
const dbUrl = pathToFileURL(path.resolve('electron/db.js')).href
const cmdUrl = pathToFileURL(path.resolve('electron/commands.js')).href
const childCode = `
  import { openDatabase } from '${dbUrl}'
  import * as cmd from '${cmdUrl}'
  const db = openDatabase(process.argv[2])
  cmd.createInbound(db, { productId: 2, quantity: 7, costPrice: 6800, location: 'A区', supplierId: null, operator: '断电测试' })
  console.log('WRITTEN')
  process.kill(process.pid, 'SIGKILL')
`
fs.writeFileSync(path.join(tmp, 'child.mjs'), childCode)
try {
  execFileSync(process.execPath, [path.join(tmp, 'child.mjs'), dbPath], { stdio: 'pipe' })
} catch (e) {
  // Windows 下被强杀的进程也表现为非零退出；用 stdout 标记确认写入确实发生过
  if (!e.stdout?.toString().includes('WRITTEN')) {
    console.error('子进程未完成写入：', e.stderr?.toString() || e.message)
    process.exit(1)
  }
}
const db2 = openDatabase(dbPath)
const recovered = db2
  .prepare("SELECT COUNT(*) AS n FROM transactions WHERE operator = '断电测试' AND type = 'in'")
  .get().n
ok('断电后已提交事务经 WAL 恢复', recovered === 1)
ok('断电恢复后库存正确', db2.prepare('SELECT quantity FROM inventory_batches WHERE product_id = 2 ORDER BY id DESC LIMIT 1').get().quantity === 7)
db2.close()

// 8. 旧库迁移：手工建 10 大类旧 schema（无 sub_category），openDatabase 后应自动重建为新 schema
const { DatabaseSync } = await import('node:sqlite')
const migPath = path.join(tmp, 'old.db')
const oldDb = new DatabaseSync(migPath)
oldDb.exec(`
  CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku_code TEXT UNIQUE NOT NULL,
      barcode TEXT,
      category TEXT NOT NULL CHECK (category IN ('台钓竿','路亚竿','海竿','渔轮','鱼线','路亚饵','鱼钩','浮漂','配件','其他')),
      brand TEXT, model TEXT,
      cost_price INTEGER NOT NULL,
      suggest_price INTEGER,
      location TEXT, photo_path TEXT, name_vi TEXT,
      status TEXT DEFAULT '待盘点' CHECK (status IN ('待盘点','已盘点','已上架虾皮','已售罄','停产')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO products (sku_code, category, brand, model, cost_price, status) VALUES
    ('JD-TD-001', '台钓竿', '光威', '老竿 3.6m', 4200, '已盘点'),
    ('JD-LU-002', '路亚竿', '达亿瓦', '老路亚 2.1m', 15500, '待盘点'),
    ('JD-PJ-003', '配件', '杂牌', '老配件', 100, '待盘点'),
    ('JD-LUR-004', '路亚饵', 'MB', '老米诺', 1200, '已上架虾皮'),
    ('JD-YL-005', '渔轮', '禧玛诺', '老纺车轮', 32000, '已盘点');
  -- 赊账包前的老结构（无 customer_id/paid_amount；无 category_filter/supplier_filter），验证 ALTER 迁移
  CREATE TABLE inventory_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      supplier_id INTEGER,
      batch_no TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      cost_price INTEGER NOT NULL,
      location TEXT,
      inbound_date DATE NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      batch_id INTEGER REFERENCES inventory_batches(id),
      type TEXT NOT NULL CHECK (type IN ('in', 'out', 'return', 'exchange')),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price INTEGER,
      selling_price INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      operator TEXT,
      notes TEXT
  );
  INSERT INTO transactions (product_id, type, quantity, unit_price, selling_price) VALUES (1, 'out', 1, 4200, 8500);
  CREATE TABLE stock_takes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      take_no TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT '进行中' CHECK (status IN ('进行中','已完成','已审核')),
      location_filter TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      operator TEXT
  );
  INSERT INTO stock_takes (take_no, status) VALUES ('ST-OLD-1', '已完成');
`)
oldDb.close()
const migDb = openDatabase(migPath)
const cols = migDb.prepare('PRAGMA table_info(products)').all().map((c) => c.name)
ok('迁移后 products 含 sub_category 列', cols.includes('sub_category'))
const migRows = migDb.prepare('SELECT sku_code, category, sub_category FROM products ORDER BY id').all()
ok('迁移保留全部行', migRows.length === 5)
ok('台钓竿→鱼竿+子类', migRows[0].category === '鱼竿' && migRows[0].sub_category === '台钓竿')
ok('路亚竿→鱼竿+子类', migRows[1].category === '鱼竿' && migRows[1].sub_category === '路亚竿')
ok('配件→工具配件', migRows[2].category === '工具配件' && migRows[2].sub_category === null)
ok('路亚饵→路亚假饵', migRows[3].category === '路亚假饵')
ok('渔轮同名保留', migRows[4].category === '渔轮')
// 迁移后的库应能正常写入（索引/约束重建完整）
const migP = cmd.createProduct(migDb, { sku_code: '', category: '鱼竿', sub_category: '手竿', brand: '光威', cost_price: 100 })
ok('迁移后的库可正常新建商品', migP.id > 0)
// 赊账包列迁移：老 transactions/stock_takes 补列成功，老数据原样保留
const migTxCols = migDb.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name)
ok('迁移后 transactions 含 customer_id/paid_amount', migTxCols.includes('customer_id') && migTxCols.includes('paid_amount'))
const migStCols = migDb.prepare('PRAGMA table_info(stock_takes)').all().map((c) => c.name)
ok('迁移后 stock_takes 含 category_filter/supplier_filter', migStCols.includes('category_filter') && migStCols.includes('supplier_filter'))
const migOldTx = migDb.prepare('SELECT paid_amount, customer_id FROM transactions').get()
ok('老流水 paid_amount 为 NULL（视为已全额付清）', migOldTx.paid_amount === null && migOldTx.customer_id === null)
ok('迁移保留老流水与老盘点单',
  migDb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n === 1
    && migDb.prepare("SELECT COUNT(*) AS n FROM stock_takes WHERE take_no = 'ST-OLD-1'").get().n === 1)
ok('赊账新表已随 schema 建好',
  !!migDb.prepare("SELECT name FROM sqlite_master WHERE name = 'customers'").get()
    && !!migDb.prepare("SELECT name FROM sqlite_master WHERE name = 'payments'").get())
// 老流水 paid_amount 为 NULL → 不纳入任何客户欠款（老数据不动）
ok('老数据不产生赊账欠款', cmd.listCustomers(migDb).every((c) => c.outstanding === 0))
migDb.close()

// 9. 备份恢复（restoreBackup）：备份 → 再改数据 → 恢复 → 回到备份时点状态
const rsPath = path.join(tmp, 'restore.db')
const rsBackupDir = path.join(tmp, 'rb-backup')
const rsDb = openDatabase(rsPath)
cmd.createProduct(rsDb, { sku_code: 'RESTORE-1', category: '其他', brand: '恢复牌', cost_price: 100 })
const rsBackup = backupNow(rsDb, rsPath, rsBackupDir)
// 备份后再写入一笔，恢复后这笔应当消失
cmd.createProduct(rsDb, { sku_code: 'RESTORE-2', category: '其他', brand: '恢复牌', cost_price: 100 })
restoreBackup(rsDb, rsBackup, rsPath)
ok('恢复前留底 .pre-restore.bak', fs.existsSync(rsPath + '.pre-restore.bak') && fs.statSync(rsPath + '.pre-restore.bak').size > 0)
rsDb.close()
const rsDb2 = openDatabase(rsPath)
const rsRows = rsDb2.prepare("SELECT sku_code FROM products WHERE sku_code LIKE 'RESTORE-%'").all().map((r) => r.sku_code)
ok('恢复后回到备份时点数据', rsRows.includes('RESTORE-1') && !rsRows.includes('RESTORE-2'))
rsDb2.close()
// 非法备份文件必须抛错，不允许覆盖好库
let rsErr1 = null
try { const d = openDatabase(path.join(tmp, 'restore2.db')); try { restoreBackup(d, path.join(tmp, 'no-such.db'), rsPath) } finally { d.close() } } catch (e) { rsErr1 = e }
ok('恢复不存在的备份文件抛错', rsErr1 !== null && rsErr1.message.includes('不存在'))
fs.writeFileSync(path.join(tmp, 'empty.db'), '')
let rsErr2 = null
try { const d = openDatabase(path.join(tmp, 'restore3.db')); try { restoreBackup(d, path.join(tmp, 'empty.db'), rsPath) } finally { d.close() } } catch (e) { rsErr2 = e }
ok('恢复空备份文件抛错', rsErr2 !== null && rsErr2.message.includes('为空'))

// 10. AI 记忆沉淀：ai_messages 落库与读取 / save_insight 写入与查询 / 记忆注入提示词组装
import {
  saveAiMessage, listAiMessages, saveInsight, listInsights, buildInsightsContext,
} from '../electron/db.js'
const aiDbPath = path.join(tmp, 'ai-mem.db')
const aiDb = openDatabase(aiDbPath)
ok('AI 表已随 schema 建好', !!aiDb.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_messages'").get()
  && !!aiDb.prepare("SELECT name FROM sqlite_master WHERE name = 'ai_insights'").get())

saveAiMessage(aiDb, 'user', '赤刃还剩几条？')
saveAiMessage(aiDb, 'assistant', '赤刃 3.6m 还剩 5 条。')
saveAiMessage(aiDb, 'tool', '{"不应该存"}')
saveAiMessage(aiDb, 'system', '不应该存')
const hist = listAiMessages(aiDb, 50)
ok('ai_messages 只存 user/assistant', hist.length === 2)
ok('ai_messages 按时间正序返回', hist[0].role === 'user' && hist[1].role === 'assistant')
ok('ai_messages 内容完整', hist[0].content === '赤刃还剩几条？' && hist[1].content.includes('5 条'))
for (let i = 0; i < 60; i++) saveAiMessage(aiDb, 'user', `第${i}条`)
const histLimit = listAiMessages(aiDb, 50)
ok('ai_history 只取最近 50 条', histLimit.length === 50)
ok('ai_history 最近 50 条是正序的最新部分', histLimit[49].content === '第59条' && histLimit[0].content === '第10条')

const si1 = saveInsight(aiDb, 'fact', '伊势尼6号钩7月周转12天')
ok('save_insight 写入成功', si1.saved === true && si1.kind === 'fact')
const si2 = saveInsight(aiDb, 'preference', '老板周五下午统一补货')
const si3 = saveInsight(aiDb, 'suggestion', '建议把赤刃 3.6m 提到门口货架')
ok('preference/suggestion 正常写入', si2.saved === true && si3.kind === 'suggestion')
const siBad = saveInsight(aiDb, 'weird-kind', '未知类型按 fact 存')
ok('未知 kind 兜底为 fact', siBad.kind === 'fact')
const siEmpty = saveInsight(aiDb, 'fact', '   ')
ok('空内容拒绝写入', siEmpty.saved === false)
const ins = listInsights(aiDb, { limit: 50 })
ok('ai_insights 列表查询返回全部', ins.length === 4 && ins.every((r) => r.active === 1))
ok('ai_insights 倒序返回最新在前', ins[0].content === '未知类型按 fact 存')

const memCtx = buildInsightsContext(aiDb, 20)
ok('记忆片段含全部 active 知识', memCtx.includes('伊势尼6号钩7月周转12天')
  && memCtx.includes('老板周五下午统一补货') && memCtx.includes('建议把赤刃 3.6m 提到门口货架'))
ok('记忆片段带类型标签', memCtx.includes('[事实]') && memCtx.includes('[偏好]') && memCtx.includes('[建议]'))
const emptyDb = openDatabase(path.join(tmp, 'ai-empty.db'))
ok('空库记忆片段为空串', buildInsightsContext(emptyDb) === '')
emptyDb.close()
// 超长记忆：写入足够多的长条目，验证总长上限生效
for (let i = 0; i < 30; i++) saveInsight(aiDb, 'fact', `长条目${i}：${'占用长度'.repeat(30)}`)
const memCtxLong = buildInsightsContext(aiDb, 100)
ok('记忆片段总长受控（≤1500 字）', memCtxLong.length <= 1500)
// active=0 的知识不注入
aiDb.prepare("UPDATE ai_insights SET active = 0 WHERE content LIKE '长条目%'").run()
const memCtxFiltered = buildInsightsContext(aiDb, 100)
ok('inactive 知识不注入提示词', !memCtxFiltered.includes('长条目'))
const insActive = listInsights(aiDb, { limit: 500, activeOnly: true })
ok('activeOnly 查询过滤 inactive', insActive.every((r) => r.active === 1) && insActive.length === 4)
aiDb.close()

// 11. 语音识别通道（ai:transcribe）注册检查：ai.js 导出、main.js 注册、preload 白名单三处齐全
// ai.js 顶层 import electron（safeStorage），无法在纯 node 下 import，这里做源码级断言
const aiSrc = fs.readFileSync(path.resolve('electron/ai.js'), 'utf8')
const mainSrc = fs.readFileSync(path.resolve('electron/main.js'), 'utf8')
const preloadSrc = fs.readFileSync(path.resolve('electron/preload.cjs'), 'utf8')
ok('ai.js 导出 transcribeAudio', /export async function transcribeAudio/.test(aiSrc))
ok('ai.js 转录走 /audio/transcriptions 且带超时', aiSrc.includes('/audio/transcriptions') && aiSrc.includes('AbortController'))
ok('main.js 注册 ai:transcribe', mainSrc.includes("handle('ai:transcribe'"))
ok('main.js 放行本应用页面的 media 权限', mainSrc.includes('setPermissionRequestHandler') && mainSrc.includes("'media'"))
ok('preload 白名单含 ai:transcribe', preloadSrc.includes("'ai:transcribe'"))

// 12. 离线语音识别（sherpa-onnx）：模型校验 + 真实中文转写 + 错误路径
// 模型目录：优先 spike/models（开发机本地副本），否则用 %APPDATA% 应用数据目录里的已下载模型（只读不写）。
// 两处都没有时真实转写用例跳过并打印（CI 无模型场景）；下载逻辑不做真实网络测试（见末尾说明）
import * as voice from '../electron/voice.js'
import { checkModel, ensureModel, MODEL_NAME, MODEL_FILES } from '../electron/modelManager.js'
import { createRequire } from 'node:module'
const require2 = createRequire(import.meta.url)
const appdataModels = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'fishing-inventory',
  'models',
)
/** 模型目录解析：spike 副本优先，%APPDATA% 兜底 */
const resolveModelDir = (name) => {
  const spikeDir = path.resolve('spike/models', name)
  return fs.existsSync(spikeDir) ? spikeDir : path.join(appdataModels, name)
}
const asrModelDir = resolveModelDir(MODEL_NAME)
const asrReady = checkModel(asrModelDir).ready

// 12a. checkModel 大小校验逻辑
if (asrReady) {
  const cm1 = checkModel(asrModelDir)
  ok('模型校验：模型目录就绪', cm1.ready === true && cm1.sizeBytes > 80_000_000)
} else {
  console.log('（跳过 ASR 模型就绪校验：spike 与 %APPDATA% 均无识别模型）')
}
const emptyModelDir = path.join(tmp, 'no-model')
const cm2 = checkModel(emptyModelDir)
ok('模型校验：目录不存在判未就绪', cm2.ready === false && cm2.missing.length === 2)
const badModelDir = path.join(tmp, 'bad-model')
fs.mkdirSync(badModelDir, { recursive: true })
fs.writeFileSync(path.join(badModelDir, 'tokens.txt'), 'x')
fs.writeFileSync(path.join(badModelDir, 'model.int8.onnx'), Buffer.alloc(100))
const cm3 = checkModel(badModelDir)
ok('模型校验：文件大小不符判未就绪', cm3.ready === false && cm3.missing.length === 2)
// 大小正确的假文件应通过校验（说明校验的是字节数而非内容，与 ensureModel 的断点续下逻辑一致）
// 直接用 MODEL_FILES 的实际字节数（从 modelManager.js 读取，模型升级后测试不用改）
for (const { file, bytes } of MODEL_FILES) {
  fs.writeFileSync(path.join(badModelDir, file), Buffer.alloc(bytes))
}
ok('模型校验：字节数正确即判就绪', checkModel(badModelDir).ready === true)

// 12b. ensureModel：已就绪时直接通过，不发网络请求
if (asrReady) {
  const emReady = await ensureModel(asrModelDir)
  ok('ensureModel：已就绪直接通过（不下载）', emReady.ok === true && emReady.dir === asrModelDir)
}

// 12c. 模型缺失时的错误路径（大白话错误，不抛异常）
voice.initVoice(emptyModelDir)
const vst = voice.voiceStatus()
ok('voiceStatus：未下载状态正确', vst.ready === false && vst.recognizerLoaded === false)
const rMiss = voice.transcribePcm({ pcm: new Float32Array(16000) })
ok('模型缺失时转写返回大白话错误', rMiss.ok === false && rMiss.reason.includes('还没下载'))
const plMiss = voice.preloadRecognizer()
ok('模型缺失时预加载返回错误不抛异常', plMiss.ok === false)

// 12d. 真实中文转写（模型存在才跑；测试音频优先模型自带 test_wavs，否则用 spike/test_wavs 里的唤醒词样本）
if (asrReady) {
  voice.initVoice(asrModelDir)
  const plOk = voice.preloadRecognizer()
  ok('识别器加载成功', plOk.ok === true && voice.voiceStatus().recognizerLoaded === true)
  const sherpa = require2('sherpa-onnx-node')
  const wavCandidates = [
    path.join(asrModelDir, 'test_wavs', '0.wav'),
    path.resolve('spike/test_wavs/xiaodu-16k.wav'),
  ]
  const wavPath = wavCandidates.find((p) => fs.existsSync(p))
  if (wavPath) {
    const wave = sherpa.readWave(wavPath)
    const r1 = voice.transcribePcm({ pcm: wave.samples, sampleRate: wave.sampleRate })
    ok('中文语音转写出文字', r1.ok === true && r1.text.length >= 2)
    ok('转写耗时在可接受范围（<3s）', r1.ok === true && r1.ms < 3000)
    // IPC 传过来的是 Buffer/Uint8Array 形态，必须同样能识别
    const r2 = voice.transcribePcm({
      pcm: Buffer.from(wave.samples.buffer, wave.samples.byteOffset, wave.samples.byteLength),
      sampleRate: 16000,
    })
    ok('Buffer 形式 PCM 识别结果一致', r2.ok === true && r2.text === r1.text)
  } else {
    console.log('（跳过真实转写：没有可用的测试 wav）')
  }
} else {
  console.log('（跳过 ASR 真实转写：识别模型不存在）')
}
const rEmpty = voice.transcribePcm({ pcm: new Float32Array(0) })
ok('空录音返回错误', rEmpty.ok === false)
const rNone = voice.transcribePcm({})
ok('无音频数据返回错误', rNone.ok === false)
// 下载逻辑（ensureModel 网络部分）不做真实网络测试：源可用性随网络环境波动，
// 已覆盖的分支是"已就绪跳过下载"与 checkModel 校验；失败清理逻辑由 review 保证。

// 13. 语音通道注册检查：voice.js 导出、main.js 注册、preload 白名单/进度订阅
const voiceSrc = fs.readFileSync(path.resolve('electron/voice.js'), 'utf8')
ok('voice.js 导出 initVoice/transcribePcm/voiceStatus',
  /export function initVoice/.test(voiceSrc) && /export function transcribePcm/.test(voiceSrc) && /export function voiceStatus/.test(voiceSrc))
ok('main.js 注册 voice 三通道', mainSrc.includes("'voice:status'") && mainSrc.includes("'voice:download'") && mainSrc.includes("'voice:transcribe'"))
ok('main.js 启动时预加载识别器', mainSrc.includes('voice.preloadRecognizer()'))
ok('preload 白名单含 voice 通道', preloadSrc.includes("'voice:status'") && preloadSrc.includes("'voice:download'") && preloadSrc.includes("'voice:transcribe'"))
ok('preload 暴露下载进度订阅', preloadSrc.includes('onVoiceProgress') && preloadSrc.includes("'voice:progress'"))
ok('打包配置 asarUnpack 覆盖 sherpa-onnx 原生文件',
  JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).build.asarUnpack.some((p) => p.includes('sherpa-onnx-win-x64')))

// 14. 离线语音合成（sherpa-onnx TTS）：模型校验 + wav 封装 + 真实中文合成 + 错误路径
import * as tts from '../electron/tts.js'
import { checkTtsModel, ensureTtsModel, TTS_MODEL_NAME } from '../electron/ttsModelManager.js'
const spikeTtsDir = resolveModelDir(TTS_MODEL_NAME)

// 14a. 通道注册检查：tts.js 导出、main.js 注册、preload 白名单/进度订阅
const ttsSrc = fs.readFileSync(path.resolve('electron/tts.js'), 'utf8')
ok('tts.js 导出 initTts/synthesize/synthesizeAsync/ttsStatus/samplesToWav',
  /export function initTts/.test(ttsSrc) && /export function synthesize\(/.test(ttsSrc)
  && /export async function synthesizeAsync/.test(ttsSrc) && /export function ttsStatus/.test(ttsSrc)
  && /export function samplesToWav/.test(ttsSrc))
ok('main.js 注册 tts 三通道', mainSrc.includes("'tts:status'") && mainSrc.includes("'tts:speak'") && mainSrc.includes("'tts:download'"))
ok('preload 白名单含 tts 通道', preloadSrc.includes("'tts:status'") && preloadSrc.includes("'tts:speak'") && preloadSrc.includes("'tts:download'"))
ok('preload 暴露 tts 进度订阅', preloadSrc.includes('onTtsProgress') && preloadSrc.includes("'tts:progress'"))

// 14b. samplesToWav：标准 16bit PCM WAV 头 + 数据长度正确
const wav0 = tts.samplesToWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 8000)
ok('wav 封装：RIFF/WAVE 头正确', wav0.toString('ascii', 0, 4) === 'RIFF' && wav0.toString('ascii', 8, 12) === 'WAVE')
ok('wav 封装：采样率与数据长度正确', wav0.readUInt32LE(24) === 8000 && wav0.length === 44 + 5 * 2 && wav0.readUInt32LE(40) === 10)
ok('wav 封装：削波保护（±1 不溢出）', wav0.readInt16LE(44 + 6) === 32767 && wav0.readInt16LE(44 + 8) === -32767)

// 14c. checkTtsModel 大小校验逻辑
const emptyTtsDir = path.join(tmp, 'no-tts')
const tc1 = checkTtsModel(emptyTtsDir)
ok('TTS 模型校验：目录不存在判未就绪', tc1.ready === false && tc1.missing.length === 6)

// 14d. 模型缺失时的错误路径（大白话错误，不抛异常）
tts.initTts(emptyTtsDir)
ok('ttsStatus：未下载状态正确', tts.ttsStatus().ready === false && tts.ttsStatus().ttsLoaded === false)
const sMiss = tts.synthesize({ text: '你好' })
ok('TTS 模型缺失时合成返回大白话错误', sMiss.ok === false && sMiss.reason.includes('还没下载'))

// 14e. 真实中文合成（spike 模型存在才跑，CI 无模型跳过并打印）
if (checkTtsModel(spikeTtsDir).ready) {
  const emTts = await ensureTtsModel(spikeTtsDir)
  ok('ensureTtsModel：已就绪直接通过（不下载）', emTts.ok === true)
  tts.initTts(spikeTtsDir)
  ok('TTS 合成器加载成功', tts.preloadTts().ok === true && tts.ttsStatus().ttsLoaded === true)
  const s1 = tts.synthesize({ text: '老板，赤刃还剩五条。' })
  ok('中文文本合成出非空 wav', s1.ok === true && s1.wav.length > 44 && s1.wav.toString('ascii', 0, 4) === 'RIFF')
  ok('合成耗时在可接受范围（<10s）', s1.ok === true && s1.ms < 10000)
  const s2 = await tts.synthesizeAsync({ text: '异步合成也没问题。' })
  ok('异步合成出非空 wav', s2.ok === true && s2.wav.length > 44)
  const sEmpty = tts.synthesize({ text: '   ' })
  ok('空文本返回错误', sEmpty.ok === false)
  const sLong = tts.synthesize({ text: '长'.repeat(501) })
  ok('超长文本拒绝合成', sLong.ok === false && sLong.reason.includes('太长'))
  const sBadSid = tts.synthesize({ text: '说话人越界回退。', sid: 9999 })
  ok('说话人 id 越界回退 0 号不报错', sBadSid.ok === true)
} else {
  console.log('（跳过 TTS 真实合成：spike 模型不存在，下载后重跑可覆盖）')
}

// 15. 唤醒词（sherpa-onnx KWS）：模型校验 + keywords 生成 + 真实检出 + 错误路径
import * as kws from '../electron/kws.js'
import { checkKwsModel, ensureKwsModel, KWS_MODEL_NAME } from '../electron/kwsModelManager.js'
const spikeKwsDir = resolveModelDir(KWS_MODEL_NAME)

// 15a. 通道注册检查
const kwsSrc = fs.readFileSync(path.resolve('electron/kws.js'), 'utf8')
ok('kws.js 导出 initKws/pushPcm/resetKws/kwsStatus',
  /export function initKws/.test(kwsSrc) && /export function pushPcm/.test(kwsSrc)
  && /export function resetKws/.test(kwsSrc) && /export function kwsStatus/.test(kwsSrc))
ok('main.js 注册 kws 四通道',
  mainSrc.includes("'kws:status'") && mainSrc.includes("'kws:download'")
  && mainSrc.includes("'kws:push'") && mainSrc.includes("'kws:reset'"))
ok('preload 白名单含 kws 通道',
  preloadSrc.includes("'kws:status'") && preloadSrc.includes("'kws:download'")
  && preloadSrc.includes("'kws:push'") && preloadSrc.includes("'kws:reset'"))
ok('preload 暴露 kws 进度订阅', preloadSrc.includes('onKwsProgress') && preloadSrc.includes("'kws:progress'"))

// 15b. checkKwsModel 大小校验逻辑
const emptyKwsDir = path.join(tmp, 'no-kws')
ok('KWS 模型校验：目录不存在判未就绪', checkKwsModel(emptyKwsDir).ready === false)

// 15c. 模型缺失时的错误路径
kws.initKws(emptyKwsDir)
ok('kwsStatus：未下载状态正确', kws.kwsStatus().ready === false && kws.kwsStatus().spotterLoaded === false)
const kMiss = kws.pushPcm({ pcm: new Float32Array(1600) })
ok('KWS 模型缺失时推送返回大白话错误', kMiss.ok === false && kMiss.reason.includes('还没下载'))

// 15d. 真实检出（KWS 模型 + TTS 模型都在才跑）
// 只读约束：KWS 引擎加载时会在模型目录生成 keywords.txt，为避免写 %APPDATA%，
// 这里把模型（约5MB）复制到临时目录再加载；TTS 引擎只读不写，直接用原目录
if (checkKwsModel(spikeKwsDir).ready && checkTtsModel(spikeTtsDir).ready) {
  const kwsTestDir = path.join(tmp, 'kws-model')
  fs.cpSync(spikeKwsDir, kwsTestDir, { recursive: true })
  const emKws = await ensureKwsModel(kwsTestDir)
  ok('ensureKwsModel：已就绪直接通过（不下载）', emKws.ok === true)
  kws.initKws(kwsTestDir)
  const kLoad = kws.preloadSpotter()
  ok('KWS 检测器加载成功', kLoad.ok === true && kws.kwsStatus().spotterLoaded === true)
  // keywords.txt 生成在模型目录，含唤醒词与拼音 token 序列
  const kwFile = fs.readFileSync(path.join(kwsTestDir, 'keywords.txt'), 'utf8')
  ok('keywords.txt 含唤醒词 token 序列', kwFile.includes('@小杜小杜') && kwFile.includes('x iǎo d ù'))

  // 16kHz wav → 0.25s 小块推送（与渲染端 wakeWord.ts 同节奏），返回检出的关键词或 null
  const feedWav16k = (pcm) => {
    kws.resetKws()
    for (let off = 0; off < pcm.length; off += 4000) {
      const r = kws.pushPcm({ pcm: pcm.subarray(off, Math.min(off + 4000, pcm.length)) })
      if (!r.ok) throw new Error(`KWS 推送失败：${r.reason}`)
      if (r.detected) return r.detected
    }
    return null
  }
  const parseWav16k = (buf) => {
    const n = (buf.length - 44) / 2
    const pcm = new Float32Array(n)
    for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(44 + i * 2) / 32768
    return pcm
  }

  // 确定性检出断言：spike/test_wavs/xiaodu-16k.wav 是 spike/make-wake-fixture.mjs 生成的
  // 「小杜小杜」合成样本（VITS 输出有随机性，夹具挑选过连续 3 次都能检出的样本，保证测试稳定）
  const fixturePath = path.resolve('spike/test_wavs/xiaodu-16k.wav')
  if (fs.existsSync(fixturePath)) {
    ok('KWS 检出「小杜小杜」（确定性夹具）', feedWav16k(parseWav16k(fs.readFileSync(fixturePath))) === '小杜小杜')
  } else {
    console.log('（跳过 KWS 夹具检出：spike/test_wavs/xiaodu-16k.wav 不存在，可跑 spike/make-wake-fixture.mjs 生成）')
  }

  // TTS 合成 → KWS 联动：VITS 输出有随机性，**单次检出率实测只有 0.267**
  // （2026-09-12 用 scripts/probe-kws-rate.mjs 实测 30 次合成命中 8 次；同一段音频重复喂 KWS 结果一致
  //  → 随机性全在合成侧，不在 KWS 侧）。
  // ⚠️ 原来写「5 次内」，按 p=0.267 算全失败概率高达 **21%** —— 与之前观察到的「约 1/3 概率偶发失败」吻合。
  //    那是**测试设计问题，不是产品回归**：它让整条验收结论不可信。
  // 改为 31 次：全失败概率降到约 **7e-5（≈1/15000）**；又因为**检测到就提前退出**，
  //    典型成本仍是 1/p ≈ 3.8 次合成，几乎不增加运行时间（只在真失败时才跑满 31 次）。
  // 这仍是一条真实性断言：TTS / KWS / 唤醒词任一坏掉 → p=0 → 必然失败。
  const ttsWavToPcm16 = (w) => {
    const n = (w.wav.length - 44) / 2
    const src = new Float32Array(n)
    for (let i = 0; i < n; i++) src[i] = w.wav.readInt16LE(44 + i * 2) / 32768
    const outLen = Math.round((n * 16000) / w.sampleRate)
    const pcm = new Float32Array(outLen + 9600) // 前后各 0.3s 静音
    for (let i = 0; i < outLen; i++) {
      const pos = (i * (n - 1)) / (outLen - 1)
      const lo = Math.floor(pos)
      pcm[4800 + i] = src[lo] * (1 - pos + lo) + src[Math.min(lo + 1, n - 1)] * (pos - lo)
    }
    return pcm
  }
  tts.initTts(spikeTtsDir)
  let synthDetected = null
  let synthTries = 0
  const SYNTH_MAX = 31
  for (let i = 0; i < SYNTH_MAX && !synthDetected; i++) {
    synthTries++
    const w = tts.synthesize({ text: '小杜小杜' })
    if (w.ok) synthDetected = feedWav16k(ttsWavToPcm16(w))
  }
  // 打印命中次数：即使断言通过，**检出率退化**（例如从现在约 3.8 次变成 20 次）也能在日志里看出来。
  // 这行是观测信息，不是断言，所以不改变断言总数。
  if (synthDetected) {
    console.log('  TTS→KWS：第 ' + synthTries + ' 次尝试命中（实测单次检出率约 0.27，期望约 3.8 次）')
  } else {
    console.log('  TTS→KWS：' + SYNTH_MAX + ' 次尝试全部未命中 —— 检出率明显退化，请查 TTS 合成与 KWS 模型')
  }
  ok('TTS 合成语音能被 KWS 检出（' + SYNTH_MAX + ' 次内）', synthDetected === '小杜小杜')

  // 负例：普通语句不应误检
  const wNeg = tts.synthesize({ text: '今天天气怎么样' })
  ok('KWS 不误检普通语句', wNeg.ok && feedWav16k(ttsWavToPcm16(wNeg)) === null)

  const kBig = kws.pushPcm({ pcm: new Float32Array(16000 * 6) })
  ok('超大音频块被拒绝', kBig.ok === false)
} else {
  console.log('（跳过 KWS 真实检出：spike 模型不存在，下载后重跑可覆盖）')
}

// 17. 意见反馈通道（feedback:send）：feedback.js 导出、main.js 注册、preload 白名单三处齐全；
// 行为断言只测本地校验与日志附带，不发真实 POST
{
  const fb = await import('../electron/feedback.js')
  const feedbackSrc = fs.readFileSync(path.resolve('electron/feedback.js'), 'utf8')
  ok('main.js 注册 feedback:send', mainSrc.includes("'feedback:send'"))
  ok('preload 白名单含 feedback:send', preloadSrc.includes("'feedback:send'"))
  ok('feedback.js 用飞书 text 消息格式', feedbackSrc.includes("msg_type: 'text'"))
  ok('feedback.js 有 30s 超时', feedbackSrc.includes('AbortController') && feedbackSrc.includes('30000'))

  const errLog = path.join(tmp, 'backup-error.log')
  fs.writeFileSync(errLog, Array.from({ length: 30 }, (_, i) => `[line ${i + 1}] some error`).join('\n'))
  fb.initFeedback({ logFile: errLog, version: '1.1.0' })
  const rBadScheme = await fb.sendFeedback({ webhook: 'http://example.com/hook', message: '测试' })
  ok('非 https 接收地址降级为本地记录（全版本开放）', rBadScheme.ok === true && rBadScheme.note)
  const rEmpty = await fb.sendFeedback({ webhook: 'https://open.feishu.cn/x', message: '  ' })
  ok('空反馈内容被拒绝（未发请求）', rEmpty.ok === false)
  // 日志附带逻辑：文件不存在时静默跳过
  fb.initFeedback({ logFile: path.join(tmp, 'no-such.log'), version: '1.1.0' })
  const rNoLog = await fb.sendFeedback({ webhook: '', message: '测试' })
  ok('无 webhook 也本地记录成功', rNoLog.ok === true && rNoLog.note)
}

// 18. 手机看店服务（electron/server.js）：无 Electron 依赖，真实 HTTP 请求打临时端口实例
import http from 'node:http'
import { createInventoryServer } from '../electron/server.js'
{
  // 通道注册检查（与 voice/tts/kws 同模式：导出、main.js 注册、preload 白名单三处齐全）
  const serverSrc = fs.readFileSync(path.resolve('electron/server.js'), 'utf8')
  ok('server.js 导出 createInventoryServer', /export function createInventoryServer/.test(serverSrc))
  ok('main.js 注册 server 三通道',
    mainSrc.includes("'server:status'") && mainSrc.includes("'server:toggle'") && mainSrc.includes("'server:regenerateToken'"))
  ok('main.js 启动并退出时关闭服务', mainSrc.includes('inventoryServer.start()') && mainSrc.includes('inventoryServer?.stop()'))
  ok('preload 白名单含 server 通道',
    preloadSrc.includes("'server:status'") && preloadSrc.includes("'server:toggle'") && preloadSrc.includes("'server:regenerateToken'"))

  const srvDir = path.join(tmp, 'srv')
  const srvDb = openDatabase(path.join(tmp, 'srv.db'))
  const srv = createInventoryServer({ db: srvDb, dataDir: srvDir, basePort: 0 })
  const st = await srv.start()
  ok('服务默认开启并启动成功', st.running === true && st.port > 0)
  const base = `http://127.0.0.1:${st.port}`
  const token = fs.readFileSync(path.join(srvDir, 'server-token.txt'), 'utf8').trim()
  ok('首次启动生成 32 位十六进制 token', /^[0-9a-f]{32}$/.test(token))
  // url 现在优先 HTTPS（语音/摄像头需要），端口是 httpsPort；没起成 HTTPS 才回退 HTTP 端口
  const urlHasPort = (st.httpsEnabled && st.url.includes(`:${st.httpsPort}`)) || (!st.httpsEnabled && st.url.includes(`:${st.port}`))
  ok('状态 URL 含 token 与端口', st.url.includes(`token=${token}`) && urlHasPort)

  // token 鉴权：无 token / 错 token → 401；query / header 两种方式都放行
  const rNoToken = await fetch(`${base}/api/summary`)
  ok('无 token 访问 API 返回 401', rNoToken.status === 401)
  ok('401 响应带安全头', rNoToken.headers.get('x-content-type-options') === 'nosniff'
    && rNoToken.headers.get('x-frame-options') === 'DENY')
  const rBadToken = await fetch(`${base}/api/summary?token=${'0'.repeat(32)}`)
  ok('错误 token 返回 401', rBadToken.status === 401)
  const rHeader = await fetch(`${base}/api/summary`, { headers: { 'x-token': token } })
  ok('x-token 请求头也可通过鉴权', rHeader.status === 200)
  const rBearer = await fetch(`${base}/api/summary`, { headers: { authorization: `Bearer ${token}` } })
  ok('Authorization Bearer 也可通过鉴权', rBearer.status === 200)

  // summary 结构与口径：期望值由种子数据推导（SEED_*），种子改动自动对齐，杜绝断言漂移。
  // 推导口径与 server.js querySummary 一致：今日=daysBack 0；in 计数量；out 计数量+按售价记营收/毛利；return 非「换货退旧」冲减。
  const sum = await (await fetch(`${base}/api/summary?token=${token}`)).json()
  ok('summary 字段齐全', ['todayRevenue', 'todayProfit', 'todayInQty', 'todayOutQty', 'totalSku', 'totalStock', 'stockValue', 'lowStockCount']
    .every((k) => typeof sum[k] === 'number'))
  const exp = { todayInQty: 0, todayOutQty: 0, todayRevenue: 0, todayProfit: 0 }
  for (const t of SEED_TRANSACTIONS.filter((tx) => tx[6] === 0)) {
    const [, , type, qty, unit, sell, , , , notes] = t
    if (type === 'in') exp.todayInQty += qty
    else if (type === 'out') {
      exp.todayOutQty += qty
      if (sell != null) exp.todayRevenue += sell * qty
      if (sell != null && unit != null) exp.todayProfit += (sell - unit) * qty
    } else if (type === 'return' && notes !== '换货退旧') {
      if (sell != null) exp.todayRevenue -= sell * qty
      if (sell != null && unit != null) exp.todayProfit -= (sell - unit) * qty
    }
  }
  exp.totalSku = SEED_PRODUCTS.length
  exp.totalStock = SEED_BATCHES.reduce((s, b) => s + b[2], 0)
  exp.stockValue = SEED_BATCHES.reduce((s, b) => s + b[2] * b[3], 0)
  ok('summary 口径与仪表盘一致（期望值由种子推导）',
    sum.totalSku === exp.totalSku && sum.todayInQty === exp.todayInQty && sum.todayOutQty === exp.todayOutQty
    && sum.todayRevenue === exp.todayRevenue && sum.todayProfit === exp.todayProfit
    && sum.totalStock === exp.totalStock && sum.stockValue === exp.stockValue
    && sum.lowStockCount === cmd.lowStockProducts(srvDb).length)

  // 低库存列表：数量与命令层口径一致（种子商品批次量均 > 默认阈值 5 → 期望 0 个）
  const low = await (await fetch(`${base}/api/low-stock?token=${token}`)).json()
  ok('低库存列表数量与命令层一致', low.length === cmd.lowStockProducts(srvDb).length)
  ok('低库存含名称/SKU/库存', low.every((r) => !!r.name && !!r.sku && typeof r.stock === 'number'))

  // 库存搜索：品牌/型号/SKU 都能命中；空关键词返回空；LIKE 通配符不注入
  const sBrand = await (await fetch(`${base}/api/inventory?token=${token}&q=${encodeURIComponent('农夫山泉')}`)).json()
  ok('按品牌搜索命中', sBrand.length === 1 && sBrand.every((r) => r.name.includes('农夫山泉')))
  const sSku = await (await fetch(`${base}/api/inventory?token=${token}&q=SP-`)).json()
  ok('按 SKU 前缀搜索命中 4 个 SP 商品', sSku.length === 4 && sSku.every((r) => r.sku.startsWith('SP-')))
  const sModel = await (await fetch(`${base}/api/inventory?token=${token}&q=${encodeURIComponent('550ml')}`)).json()
  ok('按型号搜索命中瓶装水', sModel.length === 1 && sModel[0].sku === 'SP-001')
  const sEmpty = await (await fetch(`${base}/api/inventory?token=${token}&q=`)).json()
  ok('空关键词返回空数组', Array.isArray(sEmpty) && sEmpty.length === 0)
  const sWildcard = await (await fetch(`${base}/api/inventory?token=${token}&q=${encodeURIComponent('%')}`)).json()
  ok('LIKE 通配符被转义（% 不命中全表）', sWildcard.length === 0)

  // 今日流水：条数与金额从种子推导（queryToday 口径：in 记 unit_price×qty、out 记 selling_price×qty）
  const todayRows = await (await fetch(`${base}/api/today?token=${token}`)).json()
  const todaySeedTxs = SEED_TRANSACTIONS.filter((tx) => tx[6] === 0)
  const skuOf = (prodIdx) => SEED_PRODUCTS[prodIdx - 1][0]
  const expTodayAmount = (t) => (t[2] === 'in' ? t[4] * t[3] : t[5] * t[3])
  ok('今日流水条数等于种子今日笔数', todayRows.length === todaySeedTxs.length)
  ok('今日流水字段齐全', todayRows.every((r) => r.time && r.type && r.name && r.quantity > 0 && typeof r.amount === 'number'))
  ok('今日流水逐条金额与种子推导一致（入库记成本、出库记售价）',
    todaySeedTxs.every((t) => {
      const row = todayRows.find((r) => r.sku === skuOf(t[0]) && r.type === t[2] && r.quantity === t[3])
      return row !== undefined && row.amount === expTodayAmount(t)
    }))

  // 路径白名单 + 方法限制：未知路径/路径穿越 404，非 GET 405
  const r404 = await fetch(`${base}/api/products?token=${token}`)
  ok('未注册 API 路径返回 404', r404.status === 404)
  const rTraversal = await fetch(`${base}/api/../server-token.txt?token=${token}`)
  ok('路径穿越返回 404', rTraversal.status === 404)
  const rPost = await fetch(`${base}/api/summary?token=${token}`, { method: 'POST', body: '{}' })
  ok('POST 一律 405（只读服务）', rPost.status === 405)

  // 手机端页面：无需 token，含标题与自动刷新
  const rPage = await fetch(`${base}/`)
  const html = await rPage.text()
  ok('GET / 返回手机页面（无需 token）', rPage.status === 200 && html.includes('进销存 · 手机看店'))
  ok('手机页面每 30 秒自动刷新', html.includes('setInterval(loadAll, 30000)'))
  ok('手机页面带 viewport/theme-color', html.includes('name="viewport"') && html.includes('name="theme-color"'))

  // 换 token：旧 token 立即失效，新 token 可用，文件同步更新
  const st2 = srv.regenerateToken()
  const newToken = fs.readFileSync(path.join(srvDir, 'server-token.txt'), 'utf8').trim()
  ok('换 token 后文件已更新且与旧值不同', newToken !== token && /^[0-9a-f]{32}$/.test(newToken))
  ok('换 token 后状态 URL 用新 token', st2.url.includes(`token=${newToken}`))
  const rOldToken = await fetch(`${base}/api/summary?token=${token}`)
  ok('旧 token 立即失效（401）', rOldToken.status === 401)
  const rNewToken = await fetch(`${base}/api/summary?token=${newToken}`)
  ok('新 token 立即可用', rNewToken.status === 200)

  // 开关：关闭后状态持久化到配置 json，重开实例读取同一配置
  const stOff = await srv.setEnabled(false)
  ok('关闭后服务停止', stOff.running === false && stOff.url === null)
  const cfg = JSON.parse(fs.readFileSync(path.join(srvDir, 'server-config.json'), 'utf8'))
  ok('关闭状态持久化到 server-config.json', cfg.enabled === false)
  const srvReopen = createInventoryServer({ db: srvDb, dataDir: srvDir, basePort: 0 })
  ok('新实例读取持久化配置（保持关闭）', srvReopen.status().enabled === false)
  const stOn = await srv.setEnabled(true)
  ok('重新开启后服务恢复（token 不变）', stOn.running === true && stOn.url.includes(`token=${newToken}`))
  await srv.stop()

  // 端口占用自动 +1：先在 0.0.0.0 上占住一个端口（与服务监听地址一致才会冲突），服务应落到下一个端口
  const busyPort = 28971
  const busySrv = http.createServer()
  await new Promise((resolve) => busySrv.listen(busyPort, '0.0.0.0', resolve))
  const srvRetry = createInventoryServer({ db: srvDb, dataDir: path.join(tmp, 'srv2'), basePort: busyPort })
  const stRetry = await srvRetry.start()
  ok('端口被占用时自动 +1 重试', stRetry.running === true && stRetry.port === busyPort + 1)
  await srvRetry.stop()
  await new Promise((resolve) => busySrv.close(resolve))

  // 速率限制：每 IP 每分钟 120 次，第 121 次 429（独立实例，不影响上面断言的计数）
  const srvRate = createInventoryServer({ db: srvDb, dataDir: path.join(tmp, 'srv3'), basePort: 0 })
  const stRate = await srvRate.start()
  const rateBase = `http://127.0.0.1:${stRate.port}`
  let lastStatus = 0
  for (let i = 0; i < 120; i++) lastStatus = (await fetch(`${rateBase}/`)).status
  ok('120 次请求内不限流', lastStatus === 200)
  const r429 = await fetch(`${rateBase}/`)
  ok('第 121 次请求返回 429', r429.status === 429)
  await srvRate.stop()

  srvDb.close()
}

// 19. 赊账包：客户 CRUD + 赊销（全付/部分付/纯赊）+ 还款/预收 + 对账单 + 退货冲减
// 独立库（主 db 在断电恢复测试前已关闭），种子数据照常，互不干扰
const cdb = openDatabase(path.join(tmp, 'credit.db'))
const cust = cmd.createCustomer(cdb, { name: '老王', phone: '13800000000', notes: '常客' })
ok('新建客户返回完整行', cust.id > 0 && cust.name === '老王' && cust.phone === '13800000000')
let dupCustErr = null
try { cmd.createCustomer(cdb, { name: ' 老王 ' }) } catch (e) { dupCustErr = e }
ok('同名客户拒绝建档', dupCustErr !== null && dupCustErr.message.includes('同名'))
let blankCustErr = null
try { cmd.createCustomer(cdb, { name: '   ' }) } catch (e) { blankCustErr = e }
ok('空白姓名拒绝建档', blankCustErr !== null)
const custUpd = cmd.updateCustomer(cdb, { id: cust.id, phone: '13911112222' })
ok('updateCustomer 部分更新生效', custUpd.phone === '13911112222' && custUpd.name === '老王')

// 赊账专用商品：入库 20 件 @500，售价 1000
const cp = cmd.createProduct(cdb, {
  sku_code: '', barcode: null, category: '饵料', brand: '赊账牌', model: '测试饵',
  cost_price: 500, suggest_price: 1000,
})
cmd.createInbound(cdb, { productId: cp.id, quantity: 20, costPrice: 500, location: null, supplierId: null, operator: '测试' })

// 散客全额付清：不产生欠款，流水 paid_amount 为 NULL
const s1 = cmd.confirmOutbound(cdb, { productId: cp.id, quantity: 2, sellingPrice: 1000, operator: '测试' })
ok('散客全额出库成功且无赊账', s1.ok === true && s1.creditAmount === 0 && s1.paidAmount === null)
ok('全额出库流水 paid_amount 为 NULL',
  cdb.prepare("SELECT paid_amount FROM transactions WHERE product_id = ? AND type = 'out' ORDER BY id DESC LIMIT 1").get(cp.id).paid_amount === null)

// 纯赊账（paidAmount=0）
const s2 = cmd.confirmOutbound(cdb, { productId: cp.id, quantity: 3, sellingPrice: 1000, customerId: cust.id, paidAmount: 0, operator: '测试' })
ok('纯赊账出库成功', s2.ok === true && s2.totalDue === 3000 && s2.creditAmount === 3000)
let lw = cmd.listCustomers(cdb).find((c) => c.id === cust.id)
ok('纯赊后欠款 3000', lw.outstanding === 3000 && lw.total_credit === 3000 && lw.total_paid_back === 0)
ok('客户最近交易时间已记录', typeof lw.last_deal_at === 'string')

// 部分付款
const s3 = cmd.confirmOutbound(cdb, { productId: cp.id, quantity: 5, sellingPrice: 1000, customerId: cust.id, paidAmount: 2000, operator: '测试' })
ok('部分付款赊销 3000', s3.creditAmount === 3000)

// 跨批次部分付款：实收按 FIFO 顺序分摊，未被覆盖的批次流水记 0（0 也是赊账）
cmd.createInbound(cdb, { productId: cp.id, quantity: 10, costPrice: 500, location: null, supplierId: null, operator: '测试' })
const s4 = cmd.confirmOutbound(cdb, { productId: cp.id, quantity: 15, sellingPrice: 1000, customerId: cust.id, paidAmount: 4000, operator: '测试' })
ok('跨批次赊账出库拆两条', s4.ok === true && s4.allocations.length === 2 && s4.creditAmount === 11000)
const s4rows = cdb
  .prepare("SELECT paid_amount FROM transactions WHERE product_id = ? AND type = 'out' AND customer_id = ? ORDER BY id DESC LIMIT 2")
  .all(cp.id, cust.id)
ok('实收分摊：先批次 4000、后批次 0', s4rows[1].paid_amount === 4000 && s4rows[0].paid_amount === 0)
lw = cmd.listCustomers(cdb).find((c) => c.id === cust.id)
ok('累计欠款 17000', lw.outstanding === 17000 && lw.total_credit === 17000)

// 散客部分付款/纯赊账必须报错
let creditErr = null
try { cmd.confirmOutbound(cdb, { productId: cp.id, quantity: 1, sellingPrice: 1000, paidAmount: 0, operator: '测试' }) } catch (e) { creditErr = e }
ok('散客赊账报"赊账必须选客户"', creditErr !== null && creditErr.message.includes('赊账必须选客户'))
let overPayErr = null
try { cmd.confirmOutbound(cdb, { productId: cp.id, quantity: 1, sellingPrice: 1000, customerId: cust.id, paidAmount: 1001, operator: '测试' }) } catch (e) { overPayErr = e }
ok('实收超过应付报错', overPayErr !== null && overPayErr.message.includes('实收金额不能超过应付总额'))

// 赊账买 → 退货 → 欠款冲减
const ret3 = cmd.createReturn(cdb, { productId: cp.id, quantity: 1, refundPrice: 1000, customerId: cust.id, operator: '测试' })
ok('赊账退货登记成功', ret3.ok === true)
const retCreditTx = cdb
  .prepare("SELECT customer_id, paid_amount FROM transactions WHERE product_id = ? AND type = 'return' ORDER BY id DESC LIMIT 1")
  .get(cp.id)
ok('赊账退货流水记 customer_id、paid_amount 为 NULL', retCreditTx.customer_id === cust.id && retCreditTx.paid_amount === null)
lw = cmd.listCustomers(cdb).find((c) => c.id === cust.id)
ok('退货后欠款冲减为 16000', lw.outstanding === 16000 && lw.total_credit === 16000)

// 还款：正常还款 + 多收变预收
const pay1 = cmd.recordPayment(cdb, { customerId: cust.id, amount: 5000, method: '微信' })
ok('还款 5000 后欠款 11000', pay1.ok === true && pay1.outstanding === 11000 && pay1.overpaid === false && pay1.prepaid === false)
const pay2 = cmd.recordPayment(cdb, { customerId: cust.id, amount: 20000, method: '现金', notes: '多收了' })
ok('多收允许且标注预收', pay2.ok === true && pay2.outstanding === -9000 && pay2.overpaid === true && pay2.prepaid === true)
let payAmtErr = null
try { cmd.recordPayment(cdb, { customerId: cust.id, amount: 0, method: '现金' }) } catch (e) { payAmtErr = e }
ok('还款金额必须为正整数', payAmtErr !== null)
let payCustErr = null
try { cmd.recordPayment(cdb, { customerId: 99999, amount: 100, method: '现金' }) } catch (e) { payCustErr = e }
ok('还款客户不存在报错', payCustErr !== null && payCustErr.message.includes('客户不存在'))
let payMethodErr = null
try { cmd.recordPayment(cdb, { customerId: cust.id, amount: 100, method: '欠条' }) } catch (e) { payMethodErr = e }
ok('还款方式限白名单', payMethodErr !== null)

// 对账单：赊销明细 + 还款记录，均按时间倒序
const stmt = cmd.customerStatement(cdb, { customerId: cust.id })
ok('对账单含 5 条赊销明细（含跨批次拆分与退货）', stmt.sales.length === 5)
ok('对账单含 2 条还款', stmt.payments.length === 2 && stmt.payments.every((p) => p.amount > 0 && p.method))
ok('对账单按时间倒序', stmt.sales[0].id > stmt.sales[4].id && stmt.payments[0].id > stmt.payments[1].id)
ok('对账单退货行欠款为负冲减', stmt.sales.find((s) => s.type === 'return').owed === -1000)
ok('对账单明细带商品名与应付/已付',
  stmt.sales.every((s) => s.product_name && typeof s.due === 'number' && typeof s.paid === 'number'))
ok('对账单汇总与列表口径一致', stmt.total_credit === 16000 && stmt.total_paid_back === 25000 && stmt.outstanding === -9000)
let stmtErr = null
try { cmd.customerStatement(cdb, { customerId: 99999 }) } catch (e) { stmtErr = e }
ok('对账单客户不存在报错', stmtErr !== null)

// 有流水/还款的客户拒删；无记录客户可删
const delCust = cmd.deleteCustomer(cdb, { id: cust.id })
ok('有流水客户删除被拒绝', delCust.ok === false && delCust.reason.includes('流水') && delCust.reason.includes('还款'))
const tmpCust = cmd.createCustomer(cdb, { name: '临时客户' })
ok('无记录客户可删除', cmd.deleteCustomer(cdb, { id: tmpCust.id }).ok === true)

// 通道注册检查（与 voice/tts/kws 同模式：main.js 注册 + preload 白名单）
const creditChannels = ['customer:create', 'customer:update', 'customer:delete', 'customer:list', 'customer:statement', 'payment:record']
ok('main.js 注册客户/还款通道', creditChannels.every((ch) => mainSrc.includes(`'${ch}'`)))
ok('preload 白名单含客户/还款通道', creditChannels.every((ch) => preloadSrc.includes(`'${ch}'`)))

// 20. 盘点按品类/供应商筛选（与货位筛选取交集，条件随盘点单落库）
const takeCat = cmd.createStockTake(cdb, { category: '饵料', operator: '测试' })
const catItems = cdb.prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ?').all(takeCat.id)
// 期望 = 该品类下有库存的批次数（createStockTake 只含有库存批次，出库清零的不入单）
const expCatBatches = cdb
  .prepare('SELECT COUNT(*) AS n FROM inventory_batches b JOIN products p ON p.id = b.product_id WHERE p.category = ? AND b.quantity > 0')
  .get('饵料').n
ok('按品类盘点只含该品类批次',
  catItems.length === expCatBatches && catItems.some((it) => it.product_id === cp.id)
  && catItems.every((it) => {
    const cat = cdb.prepare('SELECT category FROM products WHERE id = ?').get(it.product_id).category
    return cat === '饵料'
  }))
ok('品类筛选条件随盘点单落库', takeCat.category_filter === '饵料' && takeCat.location_filter === null)
const sup2 = cmd.createSupplier(cdb, { name: '筛选专用供应商' })
const cp2 = cmd.createProduct(cdb, { sku_code: '', barcode: null, category: '鱼线', brand: '筛选牌', cost_price: 700 })
cmd.createInbound(cdb, { productId: cp2.id, quantity: 4, costPrice: 700, location: null, supplierId: sup2.id, operator: '测试' })
const takeSup = cmd.createStockTake(cdb, { supplierId: sup2.id, operator: '测试' })
const supItems = cdb
  .prepare('SELECT si.*, b.supplier_id FROM stock_take_items si JOIN inventory_batches b ON b.id = si.batch_id WHERE si.stock_take_id = ?')
  .all(takeSup.id)
ok('按供应商盘点只含该供应商批次', supItems.length === 1 && supItems[0].supplier_id === sup2.id)
ok('供应商筛选条件随盘点单落库', takeSup.supplier_filter === sup2.id)
// 交集：品类 + 货位同时给时两个条件都生效
const takeMix = cmd.createStockTake(cdb, { category: '饵料', locationFilter: '不存在的区域', operator: '测试' })
ok('品类与货位取交集（货位不匹配则为空）',
  cdb.prepare('SELECT COUNT(*) AS n FROM stock_take_items WHERE stock_take_id = ?').get(takeMix.id).n === 0)
let badCatErr = null
try { cmd.createStockTake(cdb, { category: '外星品类', operator: '测试' }) } catch (e) { badCatErr = e }
ok('盘点品类非法报错', badCatErr !== null)
cdb.close()

// 21. 采购订单：建单 → 部分收货 → 收齐完成；超订/重复收货/错单报错；取消；原子性
const pdb = openDatabase(path.join(tmp, 'po.db'))
const poSup = cmd.createSupplier(pdb, { name: '采购测试供应商' })
const poProdA = cmd.createProduct(pdb, {
  sku_code: '', barcode: null, category: '鱼竿', brand: '采购牌', model: 'A竿',
  cost_price: 500, suggest_price: 1000,
})
const poProdB = cmd.createProduct(pdb, {
  sku_code: '', barcode: null, category: '鱼线', brand: '采购牌', model: 'B线',
  cost_price: 800, suggest_price: null,
})

// 建单校验：供应商/商品必须存在，数量正整数、进价非负整数分，明细不能为空
let poSupErr = null
try { cmd.createPurchaseOrder(pdb, { supplierId: 99999, items: [{ productId: poProdA.id, quantity: 1, costPrice: 100 }] }) } catch (e) { poSupErr = e }
ok('采购建单供应商不存在报错', poSupErr !== null && poSupErr.message.includes('供应商不存在'))
let poProdErr = null
try { cmd.createPurchaseOrder(pdb, { supplierId: poSup.id, items: [{ productId: 99999, quantity: 1, costPrice: 100 }] }) } catch (e) { poProdErr = e }
ok('采购建单商品不存在报错', poProdErr !== null && poProdErr.message.includes('商品不存在'))
let poQtyErr = null
try { cmd.createPurchaseOrder(pdb, { supplierId: poSup.id, items: [{ productId: poProdA.id, quantity: 0, costPrice: 100 }] }) } catch (e) { poQtyErr = e }
ok('采购数量必须为正整数', poQtyErr !== null && poQtyErr.message.includes('正整数'))
let poCostErr = null
try { cmd.createPurchaseOrder(pdb, { supplierId: poSup.id, items: [{ productId: poProdA.id, quantity: 1, costPrice: -1 }] }) } catch (e) { poCostErr = e }
ok('采购进价必须是非负整数分', poCostErr !== null && poCostErr.message.includes('非负整数'))
let poEmptyErr = null
try { cmd.createPurchaseOrder(pdb, { supplierId: poSup.id, items: [] }) } catch (e) { poEmptyErr = e }
ok('采购明细不能为空', poEmptyErr !== null && poEmptyErr.message.includes('采购明细不能为空'))

// 正常建单：单号 PO 开头、初始状态 sent（待收货）、总金额 = Σ 数量×进价
const po1 = cmd.createPurchaseOrder(pdb, {
  supplierId: poSup.id,
  items: [
    { productId: poProdA.id, quantity: 10, costPrice: 450 },
    { productId: poProdB.id, quantity: 4, costPrice: 800 },
  ],
  notes: '测试采购单', expectedDate: '2026-08-01', operator: '测试',
})
ok('采购单号 PO 开头当日序号', /^PO\d{8}-\d{3}$/.test(po1.po_no))
ok('采购单初始状态待收货(sent)', po1.status === 'sent')
ok('采购单总金额 = Σ数量×进价', po1.total_cost === 10 * 450 + 4 * 800)
ok('采购单备注与预计到货日落库', po1.notes === '测试采购单' && po1.expected_arrival === '2026-08-01')

// 列表与详情
const poList = cmd.listPurchaseOrders(pdb, {})
const poListRow = poList.find((r) => r.id === po1.id)
ok('采购单列表带供应商名/明细条数/进度',
  poListRow.supplier_name === '采购测试供应商' && poListRow.item_count === 2 &&
  poListRow.total_qty === 14 && poListRow.received_qty === 0)
ok('采购单列表按状态筛选', cmd.listPurchaseOrders(pdb, { status: 'sent' }).every((r) => r.status === 'sent'))
const po1Detail = cmd.purchaseOrderDetail(pdb, { id: po1.id })
ok('采购单详情带商品名/SKU/订收数量',
  po1Detail.items.length === 2 &&
  po1Detail.items[0].product_name === '采购牌 A竿' && po1Detail.items[0].sku_code === poProdA.sku_code &&
  po1Detail.items[0].quantity === 10 && po1Detail.items[0].received_qty === 0)
let poDetailErr = null
try { cmd.purchaseOrderDetail(pdb, { id: 99999 }) } catch (e) { poDetailErr = e }
ok('采购单详情订单不存在报错', poDetailErr !== null && poDetailErr.message.includes('采购订单不存在'))

// 部分收货：状态 partial；批次成本=订单进价、供应商=订单供应商；流水 notes 标注采购单号
const po1Items = po1Detail.items
const batchCountBefore = pdb.prepare('SELECT COUNT(*) AS n FROM inventory_batches').get().n
const txCountBefore = pdb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n
const recv1 = cmd.receivePurchaseOrder(pdb, { id: po1.id, items: [{ itemId: po1Items[0].id, quantity: 4 }], operator: '测试' })
ok('部分收货后状态 partial', recv1.status === 'partial')
ok('收货后明细已收数量更新', cmd.purchaseOrderDetail(pdb, { id: po1.id }).items[0].received_qty === 4)
const poBatch = pdb.prepare('SELECT * FROM inventory_batches WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(poProdA.id)
ok('收货批次成本=订单进价、供应商=订单供应商',
  poBatch.cost_price === 450 && poBatch.quantity === 4 && poBatch.supplier_id === poSup.id)
const poInTx = pdb.prepare("SELECT * FROM transactions WHERE batch_id = ? AND type = 'in'").get(poBatch.id)
ok('收货流水 type=in 且 notes 标注采购单号', poInTx !== undefined && poInTx.notes.includes(po1.po_no))
ok('收货后商品最近进价同步为订单价', pdb.prepare('SELECT cost_price FROM products WHERE id = ?').get(poProdA.id).cost_price === 450)

// 超订：订10已收4，再收7 > 剩余6
let overRecvErr = null
try { cmd.receivePurchaseOrder(pdb, { id: po1.id, items: [{ itemId: po1Items[0].id, quantity: 7 }] }) } catch (e) { overRecvErr = e }
ok('超订收货报错', overRecvErr !== null && overRecvErr.message.includes('超订'))
// 明细不属于该订单 / 订单不存在
let wrongItemErr = null
try { cmd.receivePurchaseOrder(pdb, { id: po1.id, items: [{ itemId: 999999, quantity: 1 }] }) } catch (e) { wrongItemErr = e }
ok('明细不属于该订单报错', wrongItemErr !== null && wrongItemErr.message.includes('不属于采购单'))
let noPoErr = null
try { cmd.receivePurchaseOrder(pdb, { id: 99999, items: [{ itemId: 1, quantity: 1 }] }) } catch (e) { noPoErr = e }
ok('收货订单不存在报错', noPoErr !== null && noPoErr.message.includes('采购订单不存在'))

// 收齐 → complete；已完成单再收货报"重复收货"
const recv2 = cmd.receivePurchaseOrder(pdb, {
  id: po1.id,
  items: [{ itemId: po1Items[0].id, quantity: 6 }, { itemId: po1Items[1].id, quantity: 4 }],
  operator: '测试',
})
ok('全部收齐后状态 complete', recv2.status === 'complete')
ok('列表进度同步为 14/14', cmd.listPurchaseOrders(pdb, {}).find((r) => r.id === po1.id).received_qty === 14)
let dupRecvErr = null
try { cmd.receivePurchaseOrder(pdb, { id: po1.id, items: [{ itemId: po1Items[0].id, quantity: 1 }] }) } catch (e) { dupRecvErr = e }
ok('已完成订单重复收货报错', dupRecvErr !== null && dupRecvErr.message.includes('不能重复收货'))

// 取消：待收货单可取消；重复取消报错；已完成单不能取消
const po2 = cmd.createPurchaseOrder(pdb, { supplierId: poSup.id, items: [{ productId: poProdA.id, quantity: 5, costPrice: 450 }] })
const cancel1 = cmd.cancelPurchaseOrder(pdb, { id: po2.id })
ok('待收货单取消成功', cancel1.ok === true && pdb.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po2.id).status === 'cancelled')
let dupCancelErr = null
try { cmd.cancelPurchaseOrder(pdb, { id: po2.id }) } catch (e) { dupCancelErr = e }
ok('重复取消报错', dupCancelErr !== null && dupCancelErr.message.includes('不能重复取消'))
let cancelCompleteErr = null
try { cmd.cancelPurchaseOrder(pdb, { id: po1.id }) } catch (e) { cancelCompleteErr = e }
ok('已完成单不能取消', cancelCompleteErr !== null && cancelCompleteErr.message.includes('不能取消'))
// 部分收货后取消：已收的部分保留，剩余作废
const po3 = cmd.createPurchaseOrder(pdb, { supplierId: poSup.id, items: [{ productId: poProdA.id, quantity: 5, costPrice: 450 }] })
const po3Item = cmd.purchaseOrderDetail(pdb, { id: po3.id }).items[0]
cmd.receivePurchaseOrder(pdb, { id: po3.id, items: [{ itemId: po3Item.id, quantity: 2 }] })
const cancel2 = cmd.cancelPurchaseOrder(pdb, { id: po3.id })
ok('部分收货取消提示已收部分保留', cancel2.ok === true && cancel2.message.includes('已收的部分保留'))
ok('部分收货取消后状态 cancelled', pdb.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po3.id).status === 'cancelled')
ok('部分收货取消后已收数量保留', cmd.purchaseOrderDetail(pdb, { id: po3.id }).items[0].received_qty === 2)
let recvCancelledErr = null
try { cmd.receivePurchaseOrder(pdb, { id: po3.id, items: [{ itemId: po3Item.id, quantity: 1 }] }) } catch (e) { recvCancelledErr = e }
ok('已取消订单不能收货', recvCancelledErr !== null && recvCancelledErr.message.includes('已取消'))

// 原子性：收货明细里混一条非法明细，整单回滚——批次/流水零写入、已收数量不动、状态不变
const po4 = cmd.createPurchaseOrder(pdb, {
  supplierId: poSup.id,
  items: [{ productId: poProdA.id, quantity: 5, costPrice: 450 }, { productId: poProdB.id, quantity: 3, costPrice: 800 }],
})
const po4Items = cmd.purchaseOrderDetail(pdb, { id: po4.id }).items
const b4 = pdb.prepare('SELECT COUNT(*) AS n FROM inventory_batches').get().n
const t4 = pdb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n
let atomicErr = null
try {
  cmd.receivePurchaseOrder(pdb, {
    id: po4.id,
    items: [{ itemId: po4Items[0].id, quantity: 2 }, { itemId: 999999, quantity: 1 }],
  })
} catch (e) { atomicErr = e }
ok('混合非法明细收货整体报错', atomicErr !== null)
ok('收货失败批次零写入', pdb.prepare('SELECT COUNT(*) AS n FROM inventory_batches').get().n === b4)
ok('收货失败流水零写入', pdb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n === t4)
ok('收货失败已收数量与状态不变',
  cmd.purchaseOrderDetail(pdb, { id: po4.id }).items.every((it) => it.received_qty === 0) &&
  pdb.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po4.id).status === 'sent')
// 收货前无新批次产生（防止前面的用例悄悄写批次）：收货成功后批次/流水各 +3（recv1:1 + recv2:2 + po3:1... 以差值断言见上）
ok('收货成功才产生批次与流水', b4 === batchCountBefore + 4 && t4 === txCountBefore + 4)

// 通道注册检查（与客户通道同模式）
const poChannels = ['po:create', 'po:list', 'po:detail', 'po:receive', 'po:cancel']
ok('main.js 注册采购单通道', poChannels.every((ch) => mainSrc.includes(`'${ch}'`)))
ok('preload 白名单含采购单通道', poChannels.every((ch) => preloadSrc.includes(`'${ch}'`)))

// 22. 多级定价：设/改/删/查 + 出库接入（档次价/显式售价优先/回退建议零售价/赊账组合）
const t1 = cmd.setPriceTier(pdb, { productId: poProdA.id, tier: 'wholesale', price: 900 })
ok('设置档次价成功', t1.price === 900 && t1.tier === 'wholesale')
const t1b = cmd.setPriceTier(pdb, { productId: poProdA.id, tier: 'wholesale', price: 850 })
ok('同商品同档次覆盖更新(UPSERT)', t1b.price === 850 && cmd.getPriceTiers(pdb, { productId: poProdA.id }).length === 1)
cmd.setPriceTier(pdb, { productId: poProdA.id, tier: 'regular', price: 950 })
ok('同商品多档次并存', cmd.getPriceTiers(pdb, { productId: poProdA.id }).length === 2)
let tierNameErr = null
try { cmd.setPriceTier(pdb, { productId: poProdA.id, tier: '熟人价', price: 900 }) } catch (e) { tierNameErr = e }
ok('档次名限 schema 白名单', tierNameErr !== null && tierNameErr.message.includes('价格档次必须是'))
let tierPriceErr = null
try { cmd.setPriceTier(pdb, { productId: poProdA.id, tier: 'VIP', price: 0 }) } catch (e) { tierPriceErr = e }
ok('档次价格必须为正整数分', tierPriceErr !== null && tierPriceErr.message.includes('正整数'))
let tierProdErr = null
try { cmd.setPriceTier(pdb, { productId: 99999, tier: 'VIP', price: 100 }) } catch (e) { tierProdErr = e }
ok('档次价商品不存在报错', tierProdErr !== null && tierProdErr.message.includes('商品不存在'))
ok('删除档次价成功', cmd.deletePriceTier(pdb, { productId: poProdA.id, tier: 'regular' }).ok === true)
ok('重复删除档次返回 ok=false', cmd.deletePriceTier(pdb, { productId: poProdA.id, tier: 'regular' }).ok === false)
ok('loadAll 带 priceTiers 供前端出库选择',
  cmd.loadAll(pdb).priceTiers.some((r) => r.product_id === poProdA.id && r.tier === 'wholesale' && r.price === 850))

// 出库接入：先备库存（采购收货已入 12 件 A，再手动补 10 件 B）
cmd.createInbound(pdb, { productId: poProdB.id, quantity: 10, costPrice: 800, location: null, supplierId: null, operator: '测试' })
// 选档次 → 按档次价卖（A 批发价 850）
const tOut1 = cmd.confirmOutbound(pdb, { productId: poProdA.id, quantity: 2, tier: 'wholesale', operator: '测试' })
ok('出库选档次按档次价成交', tOut1.ok === true && tOut1.totalDue === 1700)
ok('出库流水售价=档次价',
  pdb.prepare("SELECT selling_price FROM transactions WHERE product_id = ? AND type = 'out' ORDER BY id DESC LIMIT 1").get(poProdA.id).selling_price === 850)
// 显式售价优先于档次价
const tOut2 = cmd.confirmOutbound(pdb, { productId: poProdA.id, quantity: 1, sellingPrice: 1200, tier: 'wholesale', operator: '测试' })
ok('显式售价优先于档次价', tOut2.totalDue === 1200)
// 该商品没设该档 → 回退建议零售价（A 未设 VIP，suggest_price=1000）
const tOut3 = cmd.confirmOutbound(pdb, { productId: poProdA.id, quantity: 1, tier: 'VIP', operator: '测试' })
ok('没设该档回退建议零售价', tOut3.totalDue === 1000)
// 档次价和建议价都没有 → 售价记 NULL（前端手填），不报错
const tOut4 = cmd.confirmOutbound(pdb, { productId: poProdB.id, quantity: 1, tier: 'wholesale', operator: '测试' })
ok('档次价与建议价都没有时售价记 NULL', tOut4.ok === true && tOut4.totalDue === null)
ok('无售价流水 selling_price 为 NULL',
  pdb.prepare("SELECT selling_price FROM transactions WHERE product_id = ? AND type = 'out' ORDER BY id DESC LIMIT 1").get(poProdB.id).selling_price === null)
// 非法档次名在出库入口就报中文错
let outTierErr = null
try { cmd.confirmOutbound(pdb, { productId: poProdA.id, quantity: 1, tier: '黑价', operator: '测试' }) } catch (e) { outTierErr = e }
ok('出库非法档次名报错', outTierErr !== null && outTierErr.message.includes('价格档次必须是'))
// 赊账 + 档次价组合：应付按档次价算，欠款口径不变
const tierCust = cmd.createCustomer(pdb, { name: '批发老王' })
const tOut5 = cmd.confirmOutbound(pdb, {
  productId: poProdA.id, quantity: 3, tier: 'wholesale',
  customerId: tierCust.id, paidAmount: 1000, operator: '测试',
})
ok('赊账出库按档次价算应付', tOut5.totalDue === 2550 && tOut5.creditAmount === 1550)
ok('赊账+档次价欠款入账', cmd.listCustomers(pdb).find((c) => c.id === tierCust.id).outstanding === 1550)
let tierOverPayErr = null
try {
  cmd.confirmOutbound(pdb, {
    productId: poProdA.id, quantity: 1, tier: 'wholesale',
    customerId: tierCust.id, paidAmount: 851, operator: '测试',
  })
} catch (e) { tierOverPayErr = e }
ok('档次价下实收超应付仍报错', tierOverPayErr !== null && tierOverPayErr.message.includes('实收金额不能超过应付总额'))

const tierChannels = ['priceTier:set', 'priceTier:delete', 'priceTier:list']
ok('main.js 注册价格档次通道', tierChannels.every((ch) => mainSrc.includes(`'${ch}'`)))
ok('preload 白名单含价格档次通道', tierChannels.every((ch) => preloadSrc.includes(`'${ch}'`)))
pdb.close()

// 23. 客户价格档：建/改/查 + 非法档拒绝 + 老库迁移补列（NULL=零售默认）
const ldb = openDatabase(path.join(tmp, 'level.db'))
const lc1 = cmd.createCustomer(ldb, { name: 'VIP 客户', price_level: 'VIP' })
ok('新建客户带价格档', lc1.price_level === 'VIP')
const lc2 = cmd.createCustomer(ldb, { name: '普通客户' })
ok('不传价格档默认 NULL（零售）', lc2.price_level === null)
let badLevelErr = null
try { cmd.createCustomer(ldb, { name: '黑档客户', price_level: '钻石' }) } catch (e) { badLevelErr = e }
ok('非法价格档拒绝建档', badLevelErr !== null && badLevelErr.message.includes('价格档次必须是'))
ok('非法档未落库', cmd.listCustomers(ldb).every((c) => c.name !== '黑档客户'))
const lc2Upd = cmd.updateCustomer(ldb, { id: lc2.id, price_level: 'wholesale' })
ok('updateCustomer 设置价格档', lc2Upd.price_level === 'wholesale')
const lc2Keep = cmd.updateCustomer(ldb, { id: lc2.id, phone: '13700000000' })
ok('updateCustomer 不改价格档时保留', lc2Keep.price_level === 'wholesale' && lc2Keep.phone === '13700000000')
const lc2Clear = cmd.updateCustomer(ldb, { id: lc2.id, price_level: null })
ok('updateCustomer 传 null 清除价格档', lc2Clear.price_level === null)
let badUpdLevelErr = null
try { cmd.updateCustomer(ldb, { id: lc2.id, price_level: '熟人价' }) } catch (e) { badUpdLevelErr = e }
ok('非法价格档拒绝修改', badUpdLevelErr !== null && badUpdLevelErr.message.includes('价格档次必须是'))
ok('listCustomers 返回 price_level',
  cmd.listCustomers(ldb).find((c) => c.id === lc1.id).price_level === 'VIP')
ok('customerStatement 返回 price_level',
  cmd.customerStatement(ldb, { customerId: lc1.id }).customer.price_level === 'VIP')
// 五档全部合法
for (const t of ['retail', 'regular', 'VIP', 'wholesale', 'promo']) {
  cmd.updateCustomer(ldb, { id: lc2.id, price_level: t })
}
ok('五档价格档全部合法', cmd.updateCustomer(ldb, { id: lc2.id, price_level: 'promo' }).price_level === 'promo')
ldb.close()
// 老库迁移：手工建无 price_level 的老 customers 表，openDatabase 应补列且老数据为 NULL
//（DatabaseSync 已在第 8 节迁移测试中导入）
const oldLvlPath = path.join(tmp, 'level-old.db')
const oldLvlRaw = new DatabaseSync(oldLvlPath)
oldLvlRaw.exec(`CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, notes TEXT, created_at TEXT NOT NULL)`)
oldLvlRaw.prepare('INSERT INTO customers (name, created_at) VALUES (?, ?)').run('老客户', new Date().toISOString())
oldLvlRaw.close()
const oldLvlDb = openDatabase(oldLvlPath)
ok('老库迁移补 price_level 列',
  oldLvlDb.prepare('PRAGMA table_info(customers)').all().some((c) => c.name === 'price_level'))
const oldLvlRow = cmd.listCustomers(oldLvlDb).find((c) => c.name === '老客户')
ok('老数据 price_level 为 NULL（零售默认）', oldLvlRow !== undefined && oldLvlRow.price_level === null)
oldLvlDb.close()

// 24. 换货差价：补差价（全额/赊账/跨批次分摊）/退差价（现金/冲赊账）/散客赊差价报错/原子性
const xdb = openDatabase(path.join(tmp, 'exchange.db'))
const xStock = (pid) =>
  xdb.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_batches WHERE product_id = ?').get(pid).q
// 旧竿：建议价 10000，入 5 件 @6000，先散客卖 2 件 @10000（留下原售价流水）
const xo = cmd.createProduct(xdb, {
  sku_code: '', barcode: null, category: '鱼竿', brand: '换货牌', model: '旧竿',
  cost_price: 6000, suggest_price: 10000,
})
cmd.createInbound(xdb, { productId: xo.id, quantity: 5, costPrice: 6000, operator: '测试' })
cmd.confirmOutbound(xdb, { productId: xo.id, quantity: 2, sellingPrice: 10000, operator: '测试' })
// 新竿：建议价 15000，入 10 件 @8000
const xn = cmd.createProduct(xdb, {
  sku_code: '', barcode: null, category: '鱼竿', brand: '换货牌', model: '新竿',
  cost_price: 8000, suggest_price: 15000,
})
cmd.createInbound(xdb, { productId: xn.id, quantity: 10, costPrice: 8000, operator: '测试' })

// A. 补差价全额（diffPaidAmount 省略=全额付清）
const exA = cmd.createExchange(xdb, { oldProductId: xo.id, newProductId: xn.id, quantity: 1, sellingPrice: 15000, operator: '测试' })
ok('换货补差价：diff=新腿-旧腿原售价', exA.ok === true && exA.diff === 5000)
ok('补差价省略实收=全额付清', exA.diffPaid === 5000 && exA.diffCredit === 0)
ok('旧腿原售价取自原出库流水', exA.oldUnitPrice === 10000 && exA.oldPriceSource === 'transaction')
ok('换货后库存：旧 +1 新 -1', xStock(xo.id) === 4 && xStock(xn.id) === 9)
const exATx = xdb.prepare("SELECT * FROM transactions WHERE product_id = ? AND type = 'out' ORDER BY id DESC LIMIT 1").get(xn.id)
ok('补差价全额新腿流水 paid_amount 为 NULL', exATx.selling_price === 15000 && exATx.paid_amount === null && exATx.customer_id === null)
ok('旧腿仍按换货退旧记账',
  xdb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE product_id = ? AND type = 'return' AND notes = '换货退旧'").get(xo.id).n === 1)

// B. 补差价赊账（部分付，欠款入账）
const xc = cmd.createCustomer(xdb, { name: '换货老王' })
const exB = cmd.createExchange(xdb, {
  oldProductId: xo.id, newProductId: xn.id, quantity: 1, sellingPrice: 15000,
  customerId: xc.id, diffPaidAmount: 2000, operator: '测试',
})
ok('补差价赊账返回 diff/diffPaid/diffCredit', exB.diff === 5000 && exB.diffPaid === 2000 && exB.diffCredit === 3000)
const exBTx = xdb.prepare("SELECT * FROM transactions WHERE product_id = ? AND type = 'out' ORDER BY id DESC LIMIT 1").get(xn.id)
ok('赊账新腿流水记 customer_id，paid=应付-赊欠（旧货价值视为已付）',
  exBTx.customer_id === xc.id && exBTx.paid_amount === 12000)
ok('换货差价计入客户欠款', cmd.listCustomers(xdb).find((c) => c.id === xc.id).outstanding === 3000)

// B2. 跨批次出新 + 差价赊账：实收按 FIFO 分摊，未覆盖批次记 0
const xn2 = cmd.createProduct(xdb, {
  sku_code: '', barcode: null, category: '渔轮', brand: '换货牌', model: '新轮',
  cost_price: 7000, suggest_price: 15000,
})
cmd.createInbound(xdb, { productId: xn2.id, quantity: 3, costPrice: 7000, operator: '测试' })
cmd.createInbound(xdb, { productId: xn2.id, quantity: 5, costPrice: 7100, operator: '测试' })
const exB2 = cmd.createExchange(xdb, {
  oldProductId: xo.id, newProductId: xn2.id, quantity: 4, sellingPrice: 15000,
  customerId: xc.id, diffPaidAmount: 1000, operator: '测试',
})
ok('跨批次补差价：diff=4×(15000-10000)', exB2.diff === 20000 && exB2.diffPaid === 1000 && exB2.diffCredit === 19000)
const exB2Rows = xdb
  .prepare("SELECT paid_amount FROM transactions WHERE product_id = ? AND type = 'out' AND notes = '换货出新' ORDER BY id ASC")
  .all(xn2.id)
ok('跨批次实收分摊：先批次 41000、后批次 0', exB2Rows.length === 2 && exB2Rows[0].paid_amount === 41000 && exB2Rows[1].paid_amount === 0)
ok('跨批次换货欠款累计入账', cmd.listCustomers(xdb).find((c) => c.id === xc.id).outstanding === 22000)

// C. 退差价退现金（原购买非赊账）
const xm = cmd.createProduct(xdb, {
  sku_code: '', barcode: null, category: '鱼线', brand: '换货牌', model: '便宜线',
  cost_price: 3000, suggest_price: 5000,
})
cmd.createInbound(xdb, { productId: xm.id, quantity: 5, costPrice: 3000, operator: '测试' })
const exC = cmd.createExchange(xdb, { oldProductId: xo.id, newProductId: xm.id, quantity: 1, sellingPrice: 5000, operator: '测试' })
ok('退差价：diff 为负', exC.ok === true && exC.diff === -5000 && exC.refund === 5000)
ok('原购买非赊账退现金', exC.refundHandling === 'cash')
const exCTx = xdb.prepare("SELECT * FROM transactions WHERE type = 'exchange' ORDER BY id DESC LIMIT 1").get()
ok('退差价记 type=exchange 数量为正、paid_amount 为负退款额、notes 标注',
  exCTx.product_id === xo.id && exCTx.quantity === 1 && exCTx.paid_amount === -5000 &&
  exCTx.customer_id === null && exCTx.notes.includes('换货退差价'))
ok('现金退差价不影响任何客户欠款', cmd.listCustomers(xdb).find((c) => c.id === xc.id).outstanding === 22000)

// D. 退差价冲赊账（原购买赊账未付清，优先冲欠款）
const xd = cmd.createCustomer(xdb, { name: '换货老李' })
const xp = cmd.createProduct(xdb, {
  sku_code: '', barcode: null, category: '浮漂', brand: '换货牌', model: '赊销漂',
  cost_price: 4000, suggest_price: 8000,
})
cmd.createInbound(xdb, { productId: xp.id, quantity: 5, costPrice: 4000, operator: '测试' })
cmd.confirmOutbound(xdb, { productId: xp.id, quantity: 1, sellingPrice: 8000, customerId: xd.id, paidAmount: 3000, operator: '测试' })
ok('赊账购买后欠 5000', cmd.listCustomers(xdb).find((c) => c.id === xd.id).outstanding === 5000)
const xq = cmd.createProduct(xdb, {
  sku_code: '', barcode: null, category: '鱼钩', brand: '换货牌', model: '便宜钩',
  cost_price: 1500, suggest_price: 3000,
})
cmd.createInbound(xdb, { productId: xq.id, quantity: 5, costPrice: 1500, operator: '测试' })
const exD = cmd.createExchange(xdb, { oldProductId: xp.id, newProductId: xq.id, quantity: 1, sellingPrice: 3000, operator: '测试' })
ok('退差价冲赊账返回处理方式', exD.diff === -5000 && exD.refund === 5000 && exD.refundHandling === 'credit_offset' && exD.refundCustomerId === xd.id)
const exDTx = xdb.prepare("SELECT * FROM transactions WHERE type = 'exchange' ORDER BY id DESC LIMIT 1").get()
ok('冲赊账 exchange 流水记原客户', exDTx.customer_id === xd.id && exDTx.paid_amount === -5000)
ok('欠款被退差价冲减为 0', cmd.listCustomers(xdb).find((c) => c.id === xd.id).outstanding === 0)

// E. 错误路径 + 原子性
const xoStockE = xStock(xo.id)
const xnStockE = xStock(xn.id)
const txCountE = xdb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n
let walkinErr = null
try {
  cmd.createExchange(xdb, { oldProductId: xo.id, newProductId: xn.id, quantity: 1, sellingPrice: 15000, diffPaidAmount: 2000, operator: '测试' })
} catch (e) { walkinErr = e }
ok('散客赊差价报"赊账必须选客户"', walkinErr !== null && walkinErr.message.includes('赊账必须选客户'))
ok('报错后零写入（原子性）',
  xdb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n === txCountE &&
  xStock(xo.id) === xoStockE && xStock(xn.id) === xnStockE)
let overDiffErr = null
try {
  cmd.createExchange(xdb, { oldProductId: xo.id, newProductId: xn.id, quantity: 1, sellingPrice: 15000, customerId: xc.id, diffPaidAmount: 6000, operator: '测试' })
} catch (e) { overDiffErr = e }
ok('差价实收超过差价报错', overDiffErr !== null && overDiffErr.message.includes('差价实收不能超过差价'))
let badDiffCustErr = null
try {
  cmd.createExchange(xdb, { oldProductId: xo.id, newProductId: xn.id, quantity: 1, sellingPrice: 15000, customerId: 99999, diffPaidAmount: 2000, operator: '测试' })
} catch (e) { badDiffCustErr = e }
ok('换货客户不存在报错且零写入',
  badDiffCustErr !== null && badDiffCustErr.message.includes('客户不存在') &&
  xdb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n === txCountE)
// 库存不足依旧不落写入
const exShort = cmd.createExchange(xdb, { oldProductId: xo.id, newProductId: xn.id, quantity: 999, sellingPrice: 15000, operator: '测试' })
ok('换货库存不足返回 shortage', exShort.ok === false && exShort.shortage > 0 &&
  xdb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n === txCountE)
// 旧腿原售价回退：无出库流水 → 建议零售价；都没有 → 0 并标注
const xs = cmd.createProduct(xdb, {
  sku_code: '', barcode: null, category: '支架', brand: '换货牌', model: '未售支架',
  cost_price: 5000, suggest_price: 9000,
})
cmd.createInbound(xdb, { productId: xs.id, quantity: 2, costPrice: 5000, operator: '测试' })
const exS = cmd.createExchange(xdb, { oldProductId: xs.id, newProductId: xn.id, quantity: 1, sellingPrice: 15000, operator: '测试' })
ok('无出库流水回退建议零售价', exS.oldPriceSource === 'suggest' && exS.oldUnitPrice === 9000 && exS.diff === 6000)
const xz = cmd.createProduct(xdb, {
  sku_code: '', barcode: null, category: '其他', brand: '换货牌', model: '无价货',
  cost_price: 1000, suggest_price: null,
})
cmd.createInbound(xdb, { productId: xz.id, quantity: 2, costPrice: 1000, operator: '测试' })
const exZ = cmd.createExchange(xdb, { oldProductId: xz.id, newProductId: xn.id, quantity: 1, sellingPrice: 15000, operator: '测试' })
ok('原售价无处可寻按 0 并标注', exZ.oldPriceSource === 'none' && exZ.oldUnitPrice === 0 && exZ.diff === 15000)
xdb.close()

// 25. 手机写接口：POST /api/outbound 全链路 + 安全加固 + 只读端点不回退
{
  const wDir = path.join(tmp, 'srvw')
  const wdb = openDatabase(path.join(tmp, 'write.db'))
  const srvW = createInventoryServer({ db: wdb, dataDir: wDir, basePort: 0 })
  const stW = await srvW.start()
  const wBase = `http://127.0.0.1:${stW.port}`
  const wToken = fs.readFileSync(path.join(wDir, 'server-token.txt'), 'utf8').trim()
  const post = (body, headers = {}) =>
    fetch(`${wBase}/api/outbound?token=${wToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  // 开单数据源：/api/inventory 扩展字段（id/建议价/各档价格/规格），期望值由种子推导（wdb 是全新种子库）
  const wcust = cmd.createCustomer(wdb, { name: '手机客户', price_level: 'wholesale' })
  const spIdx = 7 // 种子第 8 个商品（BG-002 得力 A5 笔记本）
  const sp = SEED_PRODUCTS[spIdx]
  const spId = spIdx + 1
  const spStock = SEED_BATCHES.find((b) => b[0] === spId)[2]
  cmd.setPriceTier(wdb, { productId: spId, tier: 'wholesale', price: 7000 })
  const inv = await (await fetch(`${wBase}/api/inventory?token=${wToken}&q=${sp[0]}`)).json()
  ok('开单搜索带 id/建议价/库存', inv.length === 1 && inv[0].id === spId && inv[0].suggestPrice === sp[7] && inv[0].stock === spStock)
  ok('开单搜索带各档价格', inv[0].priceTiers.wholesale === 7000)
  const wSpec = cmd.createProduct(wdb, {
    sku_code: '', barcode: null, category: '鱼竿', brand: '手机牌', model: '测试竿',
    cost_price: 1000, suggest_price: 2000, rod_length: '3.6m', color: '黑色',
  })
  cmd.createInbound(wdb, { productId: wSpec.id, quantity: 5, costPrice: 1000, operator: '测试' })
  const invSpec = await (await fetch(`${wBase}/api/inventory?token=${wToken}&q=${encodeURIComponent('手机牌')}`)).json()
  ok('开单搜索带规格字段', invSpec[0].specs.rod_length === '3.6m' && invSpec[0].specs.color === '黑色')
  ok('无规格商品 specs 为空对象', Object.keys(inv[0].specs).length === 0)

  // GET /api/customers：id/姓名/欠款/价格档
  const custs = await (await fetch(`${wBase}/api/customers?token=${wToken}`)).json()
  ok('客户端点返回 id/姓名/欠款/价格档',
    custs.length === 1 && custs[0].id === wcust.id && custs[0].name === '手机客户' &&
    custs[0].outstanding === 0 && custs[0].priceLevel === 'wholesale')
  const rCustNoToken = await fetch(`${wBase}/api/customers`)
  ok('客户端点无 token 401', rCustNoToken.status === 401)

  // 开单成功：售价省略 → 建议价；库存减少、流水正确（期望值由种子推导）
  const r1 = await post({ productId: spId, quantity: 2 })
  const j1 = await r1.json()
  ok('手机开单成功', r1.status === 200 && j1.ok === true)
  ok('开单返回与桌面出库一致', j1.totalDue === sp[7] * 2 && j1.paidAmount === null && j1.creditAmount === 0)
  ok('开单后库存减少',
    wdb.prepare('SELECT COALESCE(SUM(quantity),0) AS q FROM inventory_batches WHERE product_id = ?').get(spId).q === spStock - 2)
  const wTx = wdb.prepare("SELECT * FROM transactions WHERE product_id = ? AND type = 'out' ORDER BY id DESC LIMIT 1").get(spId)
  ok('开单流水正确（建议价 + 操作员标注）', wTx.selling_price === sp[7] && wTx.quantity === 2 && wTx.operator === '手机开单')

  // 幂等键：同一 idempotencyKey 重复提交 → 返回原结果，不重复扣库存 / 记流水（防"重复提交弄错钱"）
  const rIdem1 = await post({ productId: spId, quantity: 1, idempotencyKey: 'dup-test-1' })
  const jIdem1 = await rIdem1.json()
  const stockAfter1 = wdb.prepare('SELECT COALESCE(SUM(quantity),0) AS q FROM inventory_batches WHERE product_id = ?').get(spId).q
  const txAfter1 = wdb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE product_id = ? AND type='out'").get(spId).n
  const rIdem2 = await post({ productId: spId, quantity: 1, idempotencyKey: 'dup-test-1' })
  const jIdem2 = await rIdem2.json()
  const stockAfter2 = wdb.prepare('SELECT COALESCE(SUM(quantity),0) AS q FROM inventory_batches WHERE product_id = ?').get(spId).q
  const txAfter2 = wdb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE product_id = ? AND type='out'").get(spId).n
  ok('幂等首提成功', rIdem1.status === 200 && jIdem1.ok === true)
  ok('幂等重复提交标记 idempotent 且返回原金额', rIdem2.status === 200 && jIdem2.idempotent === true && jIdem2.totalDue === jIdem1.totalDue && jIdem2.paidAmount === jIdem1.paidAmount && jIdem2.creditAmount === jIdem1.creditAmount)
  ok('幂等不重复扣库存', stockAfter2 === stockAfter1, stockAfter1 + ' vs ' + stockAfter2)
  ok('幂等不重复记流水', txAfter2 === txAfter1, txAfter1 + ' vs ' + txAfter2)
  // 不同 key（不同逻辑操作）应正常执行、不被去重
  const rIdem3 = await post({ productId: spId, quantity: 1, idempotencyKey: 'dup-test-2' })
  const jIdem3 = await rIdem3.json()
  ok('不同 key 正常执行不误杀', rIdem3.status === 200 && jIdem3.ok === true && jIdem3.idempotent !== true)

  // 幂等去重必须扛住「服务重启」：同一 db 上重开一个新实例（等价 pm2 restart），同一 key 仍须判重。
  // 历史实现是进程内存 Map + 15 分钟 TTL（重启即清）→ 2026-09-12 实测会重复记账；
  // 详见 任务5-缺陷体检报告-20260912.md 的 D1。此断言是该缺陷的回归防线。
  const srvAfterRestart = createInventoryServer({ db: wdb, dataDir: wDir, basePort: 0 })
  const stAfterRestart = await srvAfterRestart.start()
  const postAfterRestart = (body) =>
    fetch(`http://127.0.0.1:${stAfterRestart.port}/api/outbound?token=${wToken}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
  const txBeforeRestart = wdb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE product_id = ? AND type='out'").get(spId).n
  const rIdemRestart = await postAfterRestart({ productId: spId, quantity: 1, idempotencyKey: 'dup-test-1' })
  const jIdemRestart = await rIdemRestart.json()
  const txAfterRestart = wdb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE product_id = ? AND type='out'").get(spId).n
  ok('幂等扛住服务重启：同 key 仍判重', rIdemRestart.status === 200 && jIdemRestart.idempotent === true,
    JSON.stringify(jIdemRestart).slice(0, 100))
  ok('幂等扛住服务重启：不重复记流水', txAfterRestart === txBeforeRestart, txBeforeRestart + ' vs ' + txAfterRestart)
  await srvAfterRestart.stop()

  // 赊账开单：部分付款 → 欠款入账（应付=sp[7]，付 2/3，欠 1/3，期望由种子推导）
  const wPaid = Math.floor((sp[7] * 2) / 3)
  const r2 = await post({ productId: spId, quantity: 1, sellingPrice: sp[7], customerId: wcust.id, paidAmount: wPaid })
  const j2 = await r2.json()
  ok('手机赊账开单', r2.status === 200 && j2.creditAmount === sp[7] - wPaid)
  ok('手机开单欠款入账', cmd.listCustomers(wdb).find((c) => c.id === wcust.id).outstanding === sp[7] - wPaid)
  const r3 = await post({ productId: spId, quantity: 1, sellingPrice: sp[7], paidAmount: 0 })
  const j3 = await r3.json()
  ok('散客赊账错误信息原样返回', r3.status === 400 && j3.error.includes('赊账必须选客户'))

  // 安全加固：无 token / 错误 Content-Type / 超 body / 非法字段 / 未知字段 / 库存不足
  const rNoTok = await fetch(`${wBase}/api/outbound`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId: spId, quantity: 1 }),
  })
  ok('写接口无 token 401', rNoTok.status === 401)
  const rBadCt = await fetch(`${wBase}/api/outbound?token=${wToken}`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
  })
  ok('写接口错误 Content-Type 415', rBadCt.status === 415)
  const rBig = await post({ productId: spId, quantity: 1, pad: 'x'.repeat(9000) })
  ok('写接口超 8KB 请求体 413', rBig.status === 413)
  const rBadQty = await post({ productId: spId, quantity: 0 })
  const jBadQty = await rBadQty.json()
  ok('写接口字段非法 400 且错误原样返回', rBadQty.status === 400 && jBadQty.error.includes('正整数'))
  const rUnknown = await post({ productId: spId, quantity: 1, foo: 1 })
  ok('写接口未知字段 400', rUnknown.status === 400 && (await rUnknown.json()).error.includes('未知字段'))
  const rBadJson = await post('{not json')
  ok('写接口非法 JSON 400', rBadJson.status === 400)
  const rShort = await post({ productId: spId, quantity: 999 })
  const jShort = await rShort.json()
  ok('写接口库存不足 409', rShort.status === 409 && jShort.error.includes('库存不足'))

  // 只读端点不回退：GET 正常、其他路径 POST 仍 405、未注册路径仍 404
  ok('只读端点不受影响', (await fetch(`${wBase}/api/summary?token=${wToken}`)).status === 200)
  ok('其他路径 POST 仍 405',
    (await fetch(`${wBase}/api/summary?token=${wToken}`, { method: 'POST', body: '{}' })).status === 405)
  ok('未注册路径仍 404', (await fetch(`${wBase}/api/products?token=${wToken}`)).status === 404)

  // 手机页面含卖货页签
  const wHtml = await (await fetch(`${wBase}/`)).text()
  ok('手机页含卖货页签', wHtml.includes('卖货') && wHtml.includes('tab-btn-sell'))
  ok('手机页含开单提交逻辑', wHtml.includes('/api/outbound') && wHtml.includes('sell-submit'))

  await srvW.stop()

  // 写接口独立限流：每 IP 每分钟 30 次（未授权写尝试也计数），第 31 次 429
  const srvW2 = createInventoryServer({ db: wdb, dataDir: path.join(tmp, 'srvw2'), basePort: 0 })
  const stW2 = await srvW2.start()
  const w2Base = `http://127.0.0.1:${stW2.port}`
  let lastWrite = 0
  for (let i = 0; i < 30; i++) {
    lastWrite = (await fetch(`${w2Base}/api/outbound`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status
  }
  ok('30 次写请求内不被写限流（401 是鉴权拒绝而非限流）', lastWrite === 401)
  ok('第 31 次写请求 429', (await fetch(`${w2Base}/api/outbound`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).status === 429)
  ok('写限流不影响只读端点', (await fetch(`${w2Base}/`)).status === 200)
  await srvW2.stop()
  wdb.close()
}

// 26. 备份增强：backupStatus / 第二位置复制 / 失败降级 / stale 判定
{
  const bkDbPath = path.join(tmp, 'bk.db')
  const bkDb = openDatabase(bkDbPath)
  const bkMain = path.join(tmp, 'bk-main')
  const bkExtra = path.join(tmp, 'bk-extra')
  const bkCfg = path.join(tmp, 'bk-config', 'backup-config.json')

  // 配了第二位置：同一份备份复制过去，两边文件名一致、大小一致
  const bk1 = backupNow(bkDb, bkDbPath, bkMain, bkExtra)
  ok('主备份目录生成备份文件', fs.existsSync(bk1))
  const extraFiles = fs.readdirSync(bkExtra)
  ok('第二位置复制同一份备份',
    extraFiles.length === 1 &&
    fs.statSync(path.join(bkExtra, extraFiles[0])).size === fs.statSync(bk1).size)

  // 状态接口：读目录文件列表得出最近备份时间与份数
  saveBackupExtraDir(bkCfg, bkExtra)
  const st1 = backupStatus({ dbPath: bkDbPath, backupDir: bkMain, configPath: bkCfg })
  ok('backupStatus 返回最近备份时间与份数', st1.backupCount === 1 && typeof st1.lastBackupAt === 'string')
  ok('backupStatus 返回 extraDir 且目录可写', st1.extraDir === bkExtra && st1.extraDirOk === true)
  ok('刚备份过 stale 为 false', st1.stale === false)
  ok('backupStatus 带 dbPath', st1.dbPath === bkDbPath)

  // 失败降级：第二位置不可写（拿文件当目录）时主备份照常成功，错误记状态
  fs.writeFileSync(path.join(tmp, 'bk-notdir'), 'x')
  const bk2 = backupNow(bkDb, bkDbPath, bkMain, path.join(tmp, 'bk-notdir', 'sub'))
  ok('第二位置不可写不阻断主备份', fs.existsSync(bk2))
  saveBackupExtraDir(bkCfg, path.join(tmp, 'bk-notdir', 'sub'))
  const st2 = backupStatus({ dbPath: bkDbPath, backupDir: bkMain, configPath: bkCfg })
  ok('第二位置不可写时 extraDirOk=false 且带错误信息', st2.extraDirOk === false && typeof st2.extraError === 'string')

  // 未配置第二位置：extraDir/extraDirOk 为 null
  saveBackupExtraDir(bkCfg, null)
  const st3 = backupStatus({ dbPath: bkDbPath, backupDir: bkMain, configPath: bkCfg })
  ok('未配置第二位置时 extraDir/extraDirOk 为 null', st3.extraDir === null && st3.extraDirOk === null)
  ok('清除配置后读回为 null', loadBackupConfig(bkCfg).extraDir === null)

  // stale：最新备份距今 > 3 天 → stale:true（用 4 天前 mtime 的假备份模拟）
  const bkOld = path.join(tmp, 'bk-old')
  fs.mkdirSync(bkOld, { recursive: true })
  const oldFile = path.join(bkOld, 'inventory_backup_20200101_030000.db')
  fs.writeFileSync(oldFile, 'fake')
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3600 * 1000)
  fs.utimesSync(oldFile, fourDaysAgo, fourDaysAgo)
  const st4 = backupStatus({ dbPath: bkDbPath, backupDir: bkOld, configPath: bkCfg })
  ok('超过 3 天没备份 stale 为 true', st4.stale === true && st4.backupCount === 1)
  const st5 = backupStatus({ dbPath: bkDbPath, backupDir: path.join(tmp, 'bk-none'), configPath: bkCfg })
  ok('从未备份 stale 为 false 且份数为 0', st5.stale === false && st5.backupCount === 0 && st5.lastBackupAt === null)
  bkDb.close()
}

// 27. 过期预警：临期/已过期/库存为 0 不出现/无保质期不出现/YYYY-MM 写法
{
  const edb = openDatabase(path.join(tmp, 'exp.db'))
  // 本地日期串（与 parseExpiryDate 的本地口径对齐，避免 UTC 时差扰动断言）
  const dayStr = (offset) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    const p2 = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  }
  const eSoon = cmd.createProduct(edb, { sku_code: '', category: '饵料', brand: '临期牌', model: '十天饵', cost_price: 500, expiry_date: dayStr(10) })
  cmd.createInbound(edb, { productId: eSoon.id, quantity: 5, costPrice: 500, operator: '测试' })
  const eOld = cmd.createProduct(edb, { sku_code: '', category: '饵料', brand: '过期牌', model: '陈饵', cost_price: 500, expiry_date: dayStr(-5) })
  cmd.createInbound(edb, { productId: eOld.id, quantity: 3, costPrice: 500, operator: '测试' })
  const eNoStock = cmd.createProduct(edb, { sku_code: '', category: '饵料', brand: '零库存牌', cost_price: 500, expiry_date: dayStr(10) })
  const eNoExp = cmd.createProduct(edb, { sku_code: '', category: '鱼钩', brand: '无保质牌', cost_price: 300 })
  cmd.createInbound(edb, { productId: eNoExp.id, quantity: 8, costPrice: 300, operator: '测试' })
  const eFar = cmd.createProduct(edb, { sku_code: '', category: '饵料', brand: '远期牌', cost_price: 500, expiry_date: dayStr(60) })
  cmd.createInbound(edb, { productId: eFar.id, quantity: 2, costPrice: 500, operator: '测试' })
  // YYYY-MM 写法：当月 → 按当月最后一天算
  const nowD = new Date()
  const ym = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}`
  const eMonth = cmd.createProduct(edb, { sku_code: '', category: '饵料', brand: '当月牌', cost_price: 500, expiry_date: ym })
  cmd.createInbound(edb, { productId: eMonth.id, quantity: 1, costPrice: 500, operator: '测试' })

  const exp30 = cmd.expiringProducts(edb, { days: 30 })
  const expIds = exp30.map((x) => x.id)
  ok('临期商品上榜且带剩余天数', expIds.includes(eSoon.id) && exp30.find((x) => x.id === eSoon.id).daysLeft === 10)
  const expOld = exp30.find((x) => x.id === eOld.id)
  ok('已过期商品上榜且标记 expired', expOld !== undefined && expOld.expired === true && expOld.daysLeft === -5)
  ok('库存为 0 的临期商品不上榜', !expIds.includes(eNoStock.id))
  ok('无保质期商品不上榜', !expIds.includes(eNoExp.id))
  ok('超过 N 天的不上榜', !expIds.includes(eFar.id))
  ok('YYYY-MM 写法按当月最后一天算', expIds.includes(eMonth.id))
  ok('按过期日升序（已过期最急在前）', exp30[0].id === eOld.id)
  ok('放大窗口期能捞到远期商品', cmd.expiringProducts(edb, { days: 90 }).some((x) => x.id === eFar.id))
  ok('过期预警返回名称/SKU/库存量', exp30.every((x) => x.name && x.sku && typeof x.stock === 'number'))
  edb.close()
}

// 28. 分级库存预警：min_stock 设/改/清 NULL 回退默认 + 低库存口径 COALESCE(min_stock, 5)
const mdb = openDatabase(path.join(tmp, 'minstock.db'))
const mA = cmd.createProduct(mdb, { sku_code: '', category: '渔轮', brand: '预警牌', model: 'A轮', cost_price: 1000, min_stock: 20 })
ok('新建商品 min_stock 落库', mA.min_stock === 20)
cmd.createInbound(mdb, { productId: mA.id, quantity: 10, costPrice: 1000, operator: '测试' })
const mB = cmd.createProduct(mdb, { sku_code: '', category: '鱼钩', brand: '预警牌', model: 'B钩', cost_price: 300 })
ok('不传 min_stock 默认 NULL', mB.min_stock === null)
cmd.createInbound(mdb, { productId: mB.id, quantity: 3, costPrice: 300, operator: '测试' })
let lowList = cmd.lowStockProducts(mdb)
ok('商品 A 设 20 → 库存 10 报警', lowList.some((r) => r.id === mA.id && r.threshold === 20 && r.stock === 10))
ok('商品 B 没设 → 库存 3 按默认 5 报警', lowList.some((r) => r.id === mB.id && r.threshold === 5))
cmd.createInbound(mdb, { productId: mB.id, quantity: 2, costPrice: 300, operator: '测试' })
lowList = cmd.lowStockProducts(mdb)
ok('商品 B 补到 5 件不报警（5 不小于 5）', !lowList.some((r) => r.id === mB.id))
const mA2 = cmd.updateProduct(mdb, mA.id, { min_stock: 5 })
ok('updateProduct 改 min_stock 生效', mA2.min_stock === 5 && !cmd.lowStockProducts(mdb).some((r) => r.id === mA.id))
const mA3 = cmd.updateProduct(mdb, mA.id, { min_stock: null })
ok('min_stock 清 NULL 回退默认阈值（库存 10 不再报警）', mA3.min_stock === null && !cmd.lowStockProducts(mdb).some((r) => r.id === mA.id))
ok('loadAll 商品行带 min_stock', cmd.loadAll(mdb).products.find((x) => x.id === mA.id).min_stock === null
  && cmd.loadAll(mdb).products.find((x) => x.id === mB.id).min_stock === null)
let msErr1 = null
try { cmd.createProduct(mdb, { sku_code: '', category: '其他', cost_price: 100, min_stock: -1 }) } catch (e) { msErr1 = e }
ok('负预警线拒绝', msErr1 !== null)
let msErr2 = null
try { cmd.updateProduct(mdb, mA.id, { min_stock: 2.5 }) } catch (e) { msErr2 = e }
ok('小数预警线拒绝', msErr2 !== null)
// 老库迁移：无 min_stock 列的老 products 表 openDatabase 后补列，老数据为 NULL
{
  const msOldPath = path.join(tmp, 'minstock-old.db')
  const msOldRaw = new DatabaseSync(msOldPath)
  msOldRaw.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku_code TEXT UNIQUE NOT NULL,
      barcode TEXT,
      category TEXT NOT NULL,
      sub_category TEXT,
      brand TEXT,
      model TEXT,
      cost_price INTEGER NOT NULL,
      location TEXT,
      status TEXT DEFAULT '待盘点'
    );
    INSERT INTO products (sku_code, category, cost_price) VALUES ('OLD-MS-1', '鱼竿', 100);
  `)
  msOldRaw.close()
  const msOldDb = openDatabase(msOldPath)
  ok('老库迁移补 min_stock 列',
    msOldDb.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'min_stock'))
  ok('老数据 min_stock 为 NULL（用默认阈值）',
    msOldDb.prepare('SELECT min_stock FROM products WHERE sku_code = ?').get('OLD-MS-1').min_stock === null)
  ok('老数据按默认阈值参与低库存预警', cmd.lowStockProducts(msOldDb).some((r) => r.sku_code === 'OLD-MS-1' && r.threshold === 5))
  msOldDb.close()
}

// 29. 操作日志：各写命令埋点 / 同事务回滚 / 查询筛选
{
  const adb = openDatabase(path.join(tmp, 'audit.db'))
  const auditCount = () => adb.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n
  const aBefore = auditCount()
  const aProd = cmd.createProduct(adb, { sku_code: '', category: '鱼竿', brand: '日志牌', model: '测试竿', cost_price: 1000, suggest_price: 2000 })
  cmd.createInbound(adb, { productId: aProd.id, quantity: 10, costPrice: 1000, operator: '阿杜' })
  cmd.confirmOutbound(adb, { productId: aProd.id, quantity: 2, sellingPrice: 2000, operator: '阿杜' })
  cmd.createReturn(adb, { productId: aProd.id, quantity: 1, refundPrice: 2000, operator: '阿杜' })
  const aProd2 = cmd.createProduct(adb, { sku_code: '', category: '鱼线', brand: '日志牌', model: '换货线', cost_price: 500, suggest_price: 900 })
  cmd.createInbound(adb, { productId: aProd2.id, quantity: 5, costPrice: 500, operator: '阿杜' })
  cmd.createExchange(adb, { oldProductId: aProd.id, newProductId: aProd2.id, quantity: 1, sellingPrice: 900, operator: '阿杜' })
  cmd.setPriceTier(adb, { productId: aProd.id, tier: 'VIP', price: 1800, operator: '阿杜' })
  cmd.updateProduct(adb, aProd.id, { location: 'A区', operator: '阿杜' })
  const aCust = cmd.createCustomer(adb, { name: '日志老王' })
  cmd.recordPayment(adb, { customerId: aCust.id, amount: 1000, method: '现金' })
  const aTake = cmd.createStockTake(adb, { operator: '阿杜' })
  const aTakeItems = adb.prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ?').all(aTake.id)
  cmd.submitStockTake(adb, {
    takeId: aTake.id,
    items: aTakeItems.map((it) => ({ itemId: it.id, actualQty: it.system_qty, reason: '' })),
    operator: '阿杜',
  })
  const aSup = cmd.createSupplier(adb, { name: '日志供应商' })
  const aPo = cmd.createPurchaseOrder(adb, { supplierId: aSup.id, items: [{ productId: aProd.id, quantity: 3, costPrice: 950 }] })
  const aPoItem = cmd.purchaseOrderDetail(adb, { id: aPo.id }).items[0]
  cmd.receivePurchaseOrder(adb, { id: aPo.id, items: [{ itemId: aPoItem.id, quantity: 3 }], operator: '阿杜' })
  const aDel = cmd.createProduct(adb, { sku_code: '', category: '其他', brand: '日志牌', model: '即删', cost_price: 100 })
  cmd.deleteProduct(adb, aDel.id)

  // 埋点条数：新建商品×3 + 入库×2 + 出库/退货/换货/改价/改商品/新建客户/还账/盘点/采购收货/删商品 各1 = 15
  ok('各写命令均留下操作日志', auditCount() === aBefore + 15)
  const logs = cmd.auditLog(adb, {})
  for (const act of ['新建商品', '入库', '出库', '退货', '换货', '改价', '改商品', '新建客户', '还账', '盘点', '采购收货', '删商品']) {
    ok(`日志含动作「${act}」`, logs.some((l) => l.action === act))
  }
  ok('日志按时间倒序', logs[0].id > logs[logs.length - 1].id)
  ok('日志带对象描述（如 商品名 x2）', logs.some((l) => l.action === '出库' && l.entity.includes('测试竿') && l.entity.includes('x2')))
  ok('日志带操作员', logs.some((l) => l.action === '入库' && l.operator === '阿杜'))
  ok('日志带关键数据 detail', logs.some((l) => l.action === '改价' && l.detail.includes('1800')))
  const inLogs = cmd.auditLog(adb, { action: '入库' })
  ok('按 action 筛选日志', inLogs.length === 2 && inLogs.every((l) => l.action === '入库'))
  ok('limit 限制生效', cmd.auditLog(adb, { limit: 3 }).length === 3)

  // 同事务回滚：收货明细混一条非法明细，整单回滚——第一条已埋的日志也跟着回滚
  const aPo2 = cmd.createPurchaseOrder(adb, {
    supplierId: aSup.id,
    items: [{ productId: aProd.id, quantity: 5, costPrice: 950 }, { productId: aProd2.id, quantity: 3, costPrice: 480 }],
  })
  const aPo2Items = cmd.purchaseOrderDetail(adb, { id: aPo2.id }).items
  const auditBeforeRollback = auditCount()
  let aAtomicErr = null
  try {
    cmd.receivePurchaseOrder(adb, {
      id: aPo2.id,
      items: [{ itemId: aPo2Items[0].id, quantity: 2 }, { itemId: 999999, quantity: 1 }],
      operator: '阿杜',
    })
  } catch (e) { aAtomicErr = e }
  ok('混合非法明细收货报错', aAtomicErr !== null)
  ok('同事务回滚时日志也回滚', auditCount() === auditBeforeRollback)
  // 校验失败/业务拒绝同样不留日志
  const delBlockedA = cmd.deleteProduct(adb, aProd.id)
  ok('删除被拒绝的商品不留日志', delBlockedA.ok === false && auditCount() === auditBeforeRollback)
  adb.close()
}

// 30. 供应商对账：明细（批次/数量/金额/采购单号）+ 汇总（总额/件数/最近进货/待收金额）
const sdb = openDatabase(path.join(tmp, 'supplier.db'))
const sSup = cmd.createSupplier(sdb, { name: '对账供应商' })
const sOther = cmd.createSupplier(sdb, { name: '别家供应商' })
const sP1 = cmd.createProduct(sdb, { sku_code: '', category: '鱼竿', brand: '对账牌', model: '竿A', cost_price: 1000 })
const sP2 = cmd.createProduct(sdb, { sku_code: '', category: '鱼线', brand: '对账牌', model: '线B', cost_price: 500 })
cmd.createInbound(sdb, { productId: sP1.id, quantity: 10, costPrice: 1000, supplierId: sSup.id, operator: '测试' })
cmd.createInbound(sdb, { productId: sP2.id, quantity: 20, costPrice: 500, supplierId: sSup.id, operator: '测试' })
cmd.createInbound(sdb, { productId: sP1.id, quantity: 5, costPrice: 900, supplierId: sOther.id, operator: '测试' }) // 别家的不能算进来
const sPo = cmd.createPurchaseOrder(sdb, { supplierId: sSup.id, items: [{ productId: sP1.id, quantity: 8, costPrice: 1100 }] })
const sPoItem = cmd.purchaseOrderDetail(sdb, { id: sPo.id }).items[0]
cmd.receivePurchaseOrder(sdb, { id: sPo.id, items: [{ itemId: sPoItem.id, quantity: 3 }], operator: '测试' })
const sStmt = cmd.supplierStatement(sdb, { supplierId: sSup.id })
ok('对账单含 3 条进货明细（别家不算）', sStmt.lines.length === 3)
ok('对账明细金额=数量×成本价', sStmt.lines.every((l) => l.amount === l.quantity * l.cost_price))
ok('对账总进货金额正确', sStmt.totalAmount === 10 * 1000 + 20 * 500 + 3 * 1100)
ok('对账总件数正确', sStmt.totalQty === 10 + 20 + 3)
ok('采购收货明细带关联采购单号', sStmt.lines.find((l) => l.po_no !== null)?.po_no === sPo.po_no)
ok('手动进货明细无采购单号', sStmt.lines.filter((l) => l.po_no === null).length === 2)
ok('对账明细带批次号/日期/商品名', sStmt.lines.every((l) => l.batch_no && l.date && l.product_name))
ok('待收采购单金额=未收部分（5 件 × 1100）', sStmt.pendingPoAmount === 5 * 1100)
ok('最近一次进货时间已给出', typeof sStmt.lastInboundAt === 'string')
let sStmtErr = null
try { cmd.supplierStatement(sdb, { supplierId: 99999 }) } catch (e) { sStmtErr = e }
ok('对账供应商不存在报错', sStmtErr !== null && sStmtErr.message.includes('供应商不存在'))

// 31. 手机端新只读端点：/api/audit + /api/supplier-statement + /api/low-stock 分级阈值
{
  const sDir = path.join(tmp, 'srv4')
  const srvS = createInventoryServer({ db: sdb, dataDir: sDir, basePort: 0 })
  const stS = await srvS.start()
  const sBase = `http://127.0.0.1:${stS.port}`
  const sToken = fs.readFileSync(path.join(sDir, 'server-token.txt'), 'utf8').trim()
  const auditApi = await (await fetch(`${sBase}/api/audit?token=${sToken}`)).json()
  ok('/api/audit 返回最近 50 条内日志', Array.isArray(auditApi) && auditApi.length > 0 && auditApi.length <= 50)
  ok('/api/audit 含采购收货动作', auditApi.some((l) => l.action === '采购收货'))
  ok('/api/audit 无 token 401', (await fetch(`${sBase}/api/audit`)).status === 401)
  const ssApi = await (await fetch(`${sBase}/api/supplier-statement?token=${sToken}&id=${sSup.id}`)).json()
  ok('/api/supplier-statement 返回对账单', ssApi.totalAmount === sStmt.totalAmount && ssApi.lines.length === 3)
  const ssBad = await fetch(`${sBase}/api/supplier-statement?token=${sToken}&id=99999`)
  ok('/api/supplier-statement 供应商不存在 400', ssBad.status === 400 && (await ssBad.json()).error.includes('供应商不存在'))
  ok('/api/supplier-statement 无 token 401', (await fetch(`${sBase}/api/supplier-statement?id=${sSup.id}`)).status === 401)
  await srvS.stop()

  // 分级阈值进手机端低库存：mA 设回 20（库存 10 < 20 → 上榜且带各自阈值）
  cmd.updateProduct(mdb, mA.id, { min_stock: 20 })
  const mDir = path.join(tmp, 'srv5')
  const srvM = createInventoryServer({ db: mdb, dataDir: mDir, basePort: 0 })
  const stM = await srvM.start()
  const mBase = `http://127.0.0.1:${stM.port}`
  const mToken = fs.readFileSync(path.join(mDir, 'server-token.txt'), 'utf8').trim()
  const lowApi = await (await fetch(`${mBase}/api/low-stock?token=${mToken}`)).json()
  ok('/api/low-stock 按各自预警线预警', lowApi.some((r) => r.sku === mA.sku_code && r.threshold === 20 && r.stock === 10))
  const sumApi = await (await fetch(`${mBase}/api/summary?token=${mToken}`)).json()
  ok('/api/summary 低库存数与命令层口径一致', sumApi.lowStockCount === cmd.lowStockProducts(mdb).length)
  await srvM.stop()
}
mdb.close()
sdb.close()

// 32. 新通道注册检查（main.js + preload 白名单）
const newChannels = ['backup:status', 'backup:setExtraDir', 'backup:clearExtraDir', 'product:expiring', 'audit:list', 'supplier:statement']
ok('main.js 注册新通道', newChannels.every((ch) => mainSrc.includes(`'${ch}'`)))
ok('preload 白名单含新通道', newChannels.every((ch) => preloadSrc.includes(`'${ch}'`)))
ok('main.js 第二备份位置用目录选择框', mainSrc.includes('openDirectory'))

// 33. 商品图片存储（electron/photo.js）：无 Electron 依赖、目录注入
import { createPhotoStore } from '../electron/photo.js'
{
  const imgDir = path.join(tmp, 'images')
  const store = createPhotoStore(imgDir)
  const b64 = Buffer.from('fake-jpeg-bytes').toString('base64')
  ok('photo：写入返回相对文件名', store.save(42, b64, 'jpg') === '42.jpg')
  ok(
    'photo：文件落盘且内容一致',
    fs.readFileSync(path.join(imgDir, '42.jpg')).equals(Buffer.from('fake-jpeg-bytes')),
  )
  // 换图（含换扩展名）：旧文件清掉，同商品只剩一张
  store.save(42, Buffer.from('png-bytes').toString('base64'), 'png')
  ok(
    'photo：换扩展名覆盖后旧文件清掉',
    !fs.existsSync(path.join(imgDir, '42.jpg')) && fs.existsSync(path.join(imgDir, '42.png')),
  )
  store.save(42, b64, 'jpg')
  ok('photo：再换回 jpg 后只剩一张图', store.filesOf(42).length === 1 && fs.existsSync(path.join(imgDir, '42.jpg')))
  ok('photo：resolvePath 放行合法文件名', store.resolvePath('42.jpg') === path.resolve(imgDir, '42.jpg'))
  ok(
    'photo：路径穿越拒绝',
    store.resolvePath('../data.db') === null &&
      store.resolvePath('..\\data.db') === null &&
      store.resolvePath('a/b.jpg') === null &&
      store.resolvePath('/etc/passwd') === null &&
      store.resolvePath('C:\\x\\1.jpg') === null,
  )
  ok('photo：白名单外扩展名/无扩展名拒绝', store.resolvePath('42.exe') === null && store.resolvePath('42') === null)
  let threw = false
  try { store.save(42, b64, 'gif') } catch { threw = true }
  ok('photo：save 拒绝白名单外扩展名', threw)
  threw = false
  try { store.save(-1, b64) } catch { threw = true }
  ok('photo：save 拒绝非法商品 id', threw)
  threw = false
  try { store.save(42, '') } catch { threw = true }
  ok('photo：save 拒绝空数据', threw)
  ok('photo：remove 清掉该商品所有图', store.remove(42) === 1 && store.filesOf(42).length === 0)
  ok('photo：remove 没图的商品不报错', store.remove(999) === 0)
}

// 34. photo_path 落库（commands.updateProduct）：设/保持/清，向后兼容
// （主 db 前面已 close，用独立库；种子数据顺带供 /api/inventory 搜「光威」）
const phdb = openDatabase(path.join(tmp, 'photo.db'))
{
  const prod = cmd.createProduct(phdb, { sku_code: '', category: '其他', cost_price: 100 })
  const withPhoto = cmd.updateProduct(phdb, prod.id, { photo_path: `${prod.id}.jpg` })
  ok('photo_path 可经 updateProduct 写入', withPhoto.photo_path === `${prod.id}.jpg`)
  const untouched = cmd.updateProduct(phdb, prod.id, { brand: '不动图' })
  ok('不传 photo_path 时保持原值（向后兼容）', untouched.photo_path === `${prod.id}.jpg` && untouched.brand === '不动图')
  const cleared = cmd.updateProduct(phdb, prod.id, { photo_path: null })
  ok('photo_path 可清空', cleared.photo_path === null)
}

// 35. 手机端 /api/photo：只读图片端点（token 鉴权 + 路径穿越拒绝）+ /api/inventory 带 photoPath
{
  const pDir = path.join(tmp, 'srv-photo')
  fs.mkdirSync(path.join(pDir, 'images'), { recursive: true })
  fs.writeFileSync(path.join(pDir, 'images', '7.jpg'), Buffer.from('jpeg-bytes'))
  const srvP = createInventoryServer({ db: phdb, dataDir: pDir, basePort: 0 })
  const stP = await srvP.start()
  const pBase = `http://127.0.0.1:${stP.port}`
  const pToken = fs.readFileSync(path.join(pDir, 'server-token.txt'), 'utf8').trim()
  const r1 = await fetch(`${pBase}/api/photo?path=7.jpg&token=${pToken}`)
  ok(
    '/api/photo 返回图片（mime + 内容）',
    r1.status === 200 && r1.headers.get('content-type') === 'image/jpeg' && (await r1.text()) === 'jpeg-bytes',
  )
  const r2 = await fetch(`${pBase}/api/photo?path=${encodeURIComponent('../server-token.txt')}&token=${pToken}`)
  ok('/api/photo 路径穿越拒绝（404 且不泄露文件）', r2.status === 404)
  ok('/api/photo 白名单外扩展名 404', (await fetch(`${pBase}/api/photo?path=7.txt&token=${pToken}`)).status === 404)
  ok('/api/photo 无 token 401', (await fetch(`${pBase}/api/photo?path=7.jpg`)).status === 401)
  ok('/api/photo 文件不存在 404', (await fetch(`${pBase}/api/photo?path=8.jpg&token=${pToken}`)).status === 404)
  const inv = await (await fetch(`${pBase}/api/inventory?q=${encodeURIComponent('农夫山泉')}&token=${pToken}`)).json()
  ok('/api/inventory 带 photoPath 字段', inv.length > 0 && Object.hasOwn(inv[0], 'photoPath'))
  await srvP.stop()
}
finalCheckpoint(phdb)
phdb.close()

// 36. photo 通道注册检查（main.js + preload 白名单 + fi-img 协议）
ok('main.js 注册 photo 通道', mainSrc.includes("'photo:save'") && mainSrc.includes("'photo:delete'"))
ok('main.js 注册 fi-img 自定义协议', mainSrc.includes("protocol.handle('fi-img'"))
ok('preload 白名单含 photo 通道', preloadSrc.includes("'photo:save'") && preloadSrc.includes("'photo:delete'"))

// 36b. 商品图片两端打通（2026-09-21）
//   背景：桌面窗口是 main.js loadFile 加载的 file:// 页面。旧代码在 http 模式（中心库）下返回
//   **相对地址** `/api/photo?…` → 浏览器解析成 file:///api/photo?… → 中心库模式下桌面端
//   一张商品图都显示不出来。下面几条把修复与手机端上传链路一起锁住。
const photoSrc = fs.readFileSync(path.resolve('src/lib/photo.ts'), 'utf8')
ok(
  'photo.ts http 分支用中心库绝对地址 + 中心库令牌（桌面是 file:// 页面）',
  photoSrc.includes('getCentralConfig()') && photoSrc.includes('cfg.url.replace') && photoSrc.includes('cfg.token'),
)
ok('photo.ts 不再返回裸相对地址', !photoSrc.includes('return `/api/photo?path='))
ok('photo.ts 桌面端判据用 window.fi（手机看店/局域网浏览器页保持相对地址不变）', photoSrc.includes('!!window.fi'))
const mobilePhotoSrc = fs.readFileSync(path.resolve('electron/mobile/lib/photo.js'), 'utf8')
ok(
  '手机端图片助手存在且导出 FiPhoto',
  mobilePhotoSrc.includes('window.FiPhoto') && mobilePhotoSrc.includes('pickPhoto') && mobilePhotoSrc.includes('saveProductPhoto'),
)
ok(
  '手机端存图走 photo:save + product:update 两步',
  mobilePhotoSrc.includes("api('photo:save'") && mobilePhotoSrc.includes("api('product:update'") && mobilePhotoSrc.includes('photo_path'),
)
ok('手机端图片地址拼绝对地址（SERVER + /api/photo）', mobilePhotoSrc.includes("SERVER + '/api/photo?path='"))
ok('手机端压缩与桌面同口径（800px / 0.85）', mobilePhotoSrc.includes('MAX_EDGE = 800') && mobilePhotoSrc.includes('QUALITY = 0.85'))
const mobileInboundSrc = fs.readFileSync(path.resolve('electron/mobile/pages/inbound.js'), 'utf8')
ok('入库建档可挂商品照片', mobileInboundSrc.includes('FiPhoto.pickPhoto') && mobileInboundSrc.includes('FiPhoto.saveProductPhoto'))
ok('入库页加载了图片助手', fs.readFileSync(path.resolve('electron/mobile/index.html'), 'utf8').includes('lib/photo.js'))
ok('手机端离线缓存清单含图片助手', fs.readFileSync(path.resolve('electron/mobile/sw.js'), 'utf8').includes("BASE + 'lib/photo.js'"))
// 库存页：给**已有商品**补图/换图 + 缩略图（2026-09-21 补）
const mobileStockSrc = fs.readFileSync(path.resolve('electron/mobile/pages/stock.js'), 'utf8')
ok(
  '库存页卡片有图片位（无图时给相机占位，不藏入口）',
  mobileStockSrc.includes('data-photo-img') && mobileStockSrc.includes('FiPhoto.productPhotoUrl'),
)
ok(
  '库存页可给已有商品拍照/换图（缩略图 + 按钮两个入口，都要 stopPropagation 免得误触进开单页）',
  (mobileStockSrc.match(/pickProductPhoto\(p\)/g) || []).length >= 3,
)
ok(
  '库存页缩略图用 updated_at 穿透缓存（换图后文件名不变，不会拿旧图）',
  mobileStockSrc.includes('FiPhoto.productPhotoUrl(p.photo_path, p.updated_at)'),
)
ok('库存页缩略图懒加载（300+ SKU 不一次性拉全部图）', mobileStockSrc.includes('loading="lazy"'))
ok('手机端图片地址支持版本参数（&v=）', mobilePhotoSrc.includes('&v=') && mobilePhotoSrc.includes('version'))

// 36d. 手机端商品详情/编辑页（2026-09-21 补，对应 owner 选项 7）
//   原状：卡片上只有 热销/处理货/拍照/删除 四个开关，改价/改单位/改预警线在手机上没入口。
const mobileProductSrc = fs.readFileSync(path.resolve('electron/mobile/pages/product.js'), 'utf8')
ok('手机端有商品详情页且注册为 page(product)', mobileProductSrc.includes("page('product'"))
ok(
  '详情页保存走 product:update 命令层入口（带 operator）',
  mobileProductSrc.includes("api('product:update'") && mobileProductSrc.includes('operator: getOperator()'),
)
ok(
  '详情页换图复用 lib/photo.js（不另写一套上传）',
  mobileProductSrc.includes('FiPhoto.pickPhoto') && mobileProductSrc.includes('FiPhoto.saveProductPhoto'),
)
ok(
  '详情页有「去开单卖它」并沿用 fi-pos-preselect 约定',
  mobileProductSrc.includes('goSell') && mobileProductSrc.includes("localStorage.setItem('fi-pos-preselect'"),
)
ok(
  '详情页删除遇历史引导改停产（与库存页同一套口径）',
  mobileProductSrc.includes("status: '停产'") && mobileProductSrc.includes('product:delete'),
)
// 状态值必须落在 products.status 的 CHECK 白名单里，写错会被库直接拒绝
ok(
  '详情页状态取值都在 schema CHECK 白名单内',
  ['待盘点', '已盘点', '在售', '已售罄', '停产'].every((s) => mobileProductSrc.includes("'" + s + "'")),
)
ok(
  '详情页对可小数单位会提示（按斤/按米卖的散货）',
  mobileProductSrc.includes('allow_decimal') && mobileProductSrc.includes('可以填小数'),
)
ok('详情页保存时不传 photo_path（免得把已挂的图清掉）', !/photo_path\s*:\s*null/.test(mobileProductSrc))
const mobileAppSrc = fs.readFileSync(path.resolve('electron/mobile/app.js'), 'utf8')
ok('详情页进了按需加载清单（首屏不白等）', /LAZY_PAGES\s*=\s*\{[^}]*product:\s*1/.test(mobileAppSrc))
ok('库存页有「详情」入口且拦住了冒泡', mobileStockSrc.includes('data-detail') && mobileStockSrc.includes('openDetail(p)'))
ok('库存页把商品带进详情页（fi-product-edit）', mobileStockSrc.includes("localStorage.setItem('fi-product-edit'"))
ok('离线缓存清单含详情页', fs.readFileSync(path.resolve('electron/mobile/sw.js'), 'utf8').includes("BASE + 'pages/product.js'"))

// 36e. 主进程两条韧性修复（2026-09-21 查 crash.log 后补）
//   ⚠️ 这两个文件是**壳层**，不在热更闭包（scripts/lib/code-closure.mjs 只含 electron/commands*），
//      所以只有下次装安装包才生效 —— 断言在这里是为了防止以后被无意改回去。
ok(
  '主进程给 console 加了安全网（stdout 断了不再变成 uncaughtException）',
  mainSrc.includes('const orig = console[level].bind(console)'),
)
ok(
  '渲染进程崩溃重载有节流（60 秒最多 3 次，避免无限闪屏）',
  mainSrc.includes('recentRendererCrashes') && mainSrc.includes('render-process-gone-storm'),
)

// 36f. 手机端客户详情 + 收款登记明细（2026-09-21 补，对应 owner 选项 4）
const mobileCustLibSrc = fs.readFileSync(path.resolve('electron/mobile/lib/customer.js'), 'utf8')
ok(
  '收款面板抽成共享库（lib/customer.js 导出 FiCustomer.openPayPanel）',
  mobileCustLibSrc.includes('window.FiCustomer') && mobileCustLibSrc.includes('function openPayPanel'),
)
ok(
  '收款面板只有一份实现（客户列表页不再自带一份，免得以后只改一处）',
  !fs.readFileSync(path.resolve('electron/mobile/pages/customers.js'), 'utf8').includes('pay-btn'),
)
const mobileCustSrc = fs.readFileSync(path.resolve('electron/mobile/pages/customer.js'), 'utf8')
ok('客户详情页注册为 page(customer)', mobileCustSrc.includes("page('customer'"))
ok('客户详情页显示欠款明细（走 customer:statement）', mobileCustSrc.includes("api('customer:statement'"))
ok('客户详情页可收款（复用共享面板）', mobileCustSrc.includes('FiCustomer.openPayPanel'))
ok('客户详情页可拨号（真 <a href="tel:"> 链接，手机点一下就能打电话）', mobileCustSrc.includes('href="tel:'))
ok(
  '客户详情页 改资料/新建/删除 三个通道都在',
  mobileCustSrc.includes("api('customer:update'") &&
    mobileCustSrc.includes("api('customer:create'") &&
    mobileCustSrc.includes("api('customer:delete'"),
)
ok('客户详情页删除被拒时把原因显示出来（有历史的客户不能删）', mobileCustSrc.includes('r.reason'))
const mobileReceiptsSrc = fs.readFileSync(path.resolve('electron/mobile/pages/receipts.js'), 'utf8')
ok('收款登记明细页注册为 page(receipts)', mobileReceiptsSrc.includes("page('receipts'"))
ok(
  '收款登记明细页同时取对账与登记流水（receipt:reconcile + receipt:list）',
  mobileReceiptsSrc.includes("api('receipt:reconcile'") && mobileReceiptsSrc.includes("api('receipt:list'"),
)
ok('登记流水显示是谁登的（operator —— 原来这一栏从没被显示过）', mobileReceiptsSrc.includes('operator'))
ok('「更多」里的收款登记改指向明细页', /收款登记[\s\S]{0,200}navigate\('receipts'\)/.test(mobileAppSrc))
const mobileCustListSrc = fs.readFileSync(path.resolve('electron/mobile/pages/customers.js'), 'utf8')
ok('客户列表页有「详情」入口且拦住冒泡', mobileCustListSrc.includes('data-detail') && mobileCustListSrc.includes('stopPropagation'))
ok('客户列表页可新增客户', mobileCustListSrc.includes('新增客户'))
ok(
  '共享客户库与新页面都进了首屏加载与离线缓存',
  fs.readFileSync(path.resolve('electron/mobile/index.html'), 'utf8').includes('lib/customer.js') &&
    ['lib/customer.js', 'pages/customer.js', 'pages/receipts.js'].every((f) =>
      fs.readFileSync(path.resolve('electron/mobile/sw.js'), 'utf8').includes(f),
    ),
)
ok(
  'customer / receipts 都在按需加载清单里',
  /LAZY_PAGES\s*=\s*\{[^}]*customer:\s*1/.test(mobileAppSrc) && /LAZY_PAGES\s*=\s*\{[^}]*receipts:\s*1/.test(mobileAppSrc),
)

// 36g. 发壳审计工具（2026-09-21 补，对应 owner 选项 3「下次装壳清单」）
const shellAuditSrc = fs.readFileSync(path.resolve('scripts/shell-release-audit.mjs'), 'utf8')
ok('有发壳审计脚本（用同一份 computeCodeClosure 算"哪些热更推不到"）', shellAuditSrc.includes('computeCodeClosure'))
ok(
  '发壳审计把手机端与真壳层分开（两者发版路径不同，混在一起会误判）',
  shellAuditSrc.includes('shellMobile') && shellAuditSrc.includes('shellCore'),
)

// 36c. 手机端传图全链路（真实走 /api/invoke，与手机端 lib/photo.js 的两步完全一致）
//   手机拍完图不做任何"同步"——图片就存在**账本所在那台机器**上，products.photo_path 存文件名，
//   因此手机与电脑看的是同一张图（前提是 36b 的地址修复在位）。
{
  const mpDir = path.join(tmp, 'mobile-photo')
  const mpdb = openDatabase(path.join(mpDir, 'data.db'))
  const srvMP = createInventoryServer({ db: mpdb, dataDir: mpDir, basePort: 0 })
  const stMP = await srvMP.start()
  const mpBase = `http://127.0.0.1:${stMP.port}`
  const mpToken = fs.readFileSync(path.join(mpDir, 'server-token.txt'), 'utf8').trim()
  const call = (channel, payload) =>
    fetch(`${mpBase}/api/invoke?token=${mpToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, payload }),
    }).then(async (r) => {
      const body = await r.json().catch(() => ({}))
      // 手机端 app.js 的 invokeRaw 返回的是 data.result（拆掉 {ok,result} 外层）——
      // 测试按**手机端同一契约**断言，否则测的就不是手机真正拿到的东西。
      return { status: r.status, result: body.result }
    })

  const mp = cmd.createProduct(mpdb, { sku_code: 'MP-1', category: '其他', brand: '手机牌', model: '拍照款', cost_price: 500 })
  const phoneJpeg = Buffer.from('phone-jpeg-bytes')
  // ① 第一步：存图（photo:save 只落盘、不动数据库 —— 与桌面端同一口径）
  const savedMp = await call('photo:save', { productId: mp.id, base64: phoneJpeg.toString('base64'), ext: 'jpg' })
  ok(
    '手机端 photo:save 返回相对文件名',
    savedMp.status === 200 && !!savedMp.result && savedMp.result.ok === true && savedMp.result.path === `${mp.id}.jpg`,
  )
  const mpImg = path.join(mpDir, 'images', `${mp.id}.jpg`)
  ok('手机端 photo:save 图片落到账本机器的 images/', fs.existsSync(mpImg) && fs.readFileSync(mpImg).equals(phoneJpeg))
  // ② 第二步：把文件名挂到商品上
  const linkedMp = await call('product:update', { id: mp.id, photo_path: `${mp.id}.jpg` })
  ok(
    '手机端 product:update 挂上 photo_path',
    linkedMp.status === 200 && mpdb.prepare('SELECT photo_path FROM products WHERE id = ?').get(mp.id).photo_path === `${mp.id}.jpg`,
  )
  // ③ 挂上后，手机与电脑走同一个取图出口
  const gotImg = await fetch(`${mpBase}/api/photo?path=${mp.id}.jpg&token=${mpToken}`)
  ok(
    '挂图后 /api/photo 取得到（两端同一出口）',
    gotImg.status === 200 && gotImg.headers.get('content-type') === 'image/jpeg' && (await gotImg.text()) === 'phone-jpeg-bytes',
  )
  const invMp = await (await fetch(`${mpBase}/api/inventory?q=${encodeURIComponent('拍照款')}&token=${mpToken}`)).json()
  ok('库存接口带回 photoPath（列表出缩略图）', invMp.length > 0 && invMp[0].photoPath === `${mp.id}.jpg`)
  // ④ 删图：文件与库字段一起清（与桌面端同一条命令层路径）
  await call('photo:delete', { productId: mp.id })
  ok('删图同时清文件与 photo_path', !fs.existsSync(mpImg) && mpdb.prepare('SELECT photo_path FROM products WHERE id = ?').get(mp.id).photo_path === null)
  await srvMP.stop()
  mpdb.close()
}

// 37. 批量修改商品（batchUpdateProducts）：打折/统一价/状态/audit 埋点/档次价同步/原子回滚
{
  const bdb = openDatabase(path.join(tmp, 'batch.db'))
  const b1 = cmd.createProduct(bdb, { sku_code: '', category: '鱼竿', brand: '批量牌', model: '竿A', cost_price: 1000, suggest_price: 2000 })
  const b2 = cmd.createProduct(bdb, { sku_code: '', category: '鱼线', brand: '批量牌', model: '线B', cost_price: 500, suggest_price: 999 })
  const b3 = cmd.createProduct(bdb, { sku_code: '', category: '鱼钩', brand: '批量牌', model: '钩C', cost_price: 100 }) // 无建议售价
  cmd.setPriceTier(bdb, { productId: b1.id, tier: 'VIP', price: 1500 })
  cmd.setPriceTier(bdb, { productId: b2.id, tier: 'wholesale', price: 777 })
  const bAuditN = () => bdb.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n
  const bProd = (id) => bdb.prepare('SELECT * FROM products WHERE id = ?').get(id)
  const bTier = (id, tier) => bdb.prepare('SELECT * FROM price_tiers WHERE product_id = ? AND tier = ?').get(id, tier)

  // 统一打 9 折：建议售价 + 已设档次价同步（分单位四舍五入）；没设建议售价的保持 NULL
  const before1 = bAuditN()
  const r1 = cmd.batchUpdateProducts(bdb, { ids: [b1.id, b2.id, b3.id], priceMode: { kind: 'ratio', ratio: 0.9 }, operator: '阿杜' })
  ok('批量打折返回更新数与档次价数', r1.ok === true && r1.updated === 3 && r1.tiersUpdated === 2)
  ok('批量打折：建议售价 ×0.9 四舍五入', bProd(b1.id).suggest_price === 1800 && bProd(b2.id).suggest_price === 899)
  ok('批量打折：档次价同步 ×0.9', bTier(b1.id, 'VIP').price === 1350 && bTier(b2.id, 'wholesale').price === 699)
  ok('批量打折：没设建议售价的保持 NULL 且不补建档次',
    bProd(b3.id).suggest_price === null &&
      bdb.prepare('SELECT COUNT(*) AS n FROM price_tiers WHERE product_id = ?').get(b3.id).n === 0)
  const priceLog = cmd.auditLog(bdb, { action: '批量改价' })
  ok('批量改价记一条日志（含数量与折扣）',
    priceLog.length === 1 && priceLog[0].entity.includes('3 个商品') && priceLog[0].detail.includes('0.9'))
  ok('批量打折只新增一条日志', bAuditN() === before1 + 1)

  // 统一改为固定价
  cmd.batchUpdateProducts(bdb, { ids: [b1.id, b2.id], priceMode: { kind: 'fixed', priceFen: 500 } })
  ok('批量统一价：建议售价与档次价都改成固定价',
    bProd(b1.id).suggest_price === 500 && bTier(b1.id, 'VIP').price === 500 &&
      bProd(b2.id).suggest_price === 500 && bTier(b2.id, 'wholesale').price === 500)

  // 批量改状态
  cmd.batchUpdateProducts(bdb, { ids: [b1.id, b3.id], status: '停产' })
  ok('批量改状态生效', bProd(b1.id).status === '停产' && bProd(b3.id).status === '停产' && bProd(b2.id).status !== '停产')
  ok('批量改状态记一条日志',
    cmd.auditLog(bdb, { action: '批量改状态' }).some((l) => l.entity.includes('2 个商品') && l.entity.includes('停产')))

  // 参数校验与原子回滚
  let bErr = null
  try { cmd.batchUpdateProducts(bdb, { ids: [], priceMode: { kind: 'ratio', ratio: 0.9 } }) } catch (e) { bErr = e }
  ok('空列表拒绝', bErr !== null)
  bErr = null
  try { cmd.batchUpdateProducts(bdb, { ids: [b1.id] }) } catch (e) { bErr = e }
  ok('改价和状态都不传拒绝', bErr !== null)
  bErr = null
  try { cmd.batchUpdateProducts(bdb, { ids: [b1.id], priceMode: { kind: 'ratio', ratio: 0 } }) } catch (e) { bErr = e }
  ok('折扣为 0 拒绝', bErr !== null)
  bErr = null
  try { cmd.batchUpdateProducts(bdb, { ids: [b1.id], priceMode: { kind: 'fixed', priceFen: -5 } }) } catch (e) { bErr = e }
  ok('负统一价拒绝', bErr !== null)
  bErr = null
  try { cmd.batchUpdateProducts(bdb, { ids: [b1.id], status: '在架' }) } catch (e) { bErr = e }
  ok('非法状态拒绝', bErr !== null)
  // 混一个不存在的 id：整批回滚（已改的第一个商品也复原），日志不留
  const beforeRollback = bAuditN()
  const suggestBefore = bProd(b1.id).suggest_price
  bErr = null
  try { cmd.batchUpdateProducts(bdb, { ids: [b1.id, 999999], priceMode: { kind: 'ratio', ratio: 0.5 } }) } catch (e) { bErr = e }
  ok('含不存在商品报错', bErr !== null)
  ok('整批回滚：价格复原且不留日志', bProd(b1.id).suggest_price === suggestBefore && bAuditN() === beforeRollback)
  bdb.close()
}

// 38. importBatch update 模式：更新字段/SKU 不动/库存不动/空列不覆盖/计数正确/audit/默认 skip 兼容
{
  const udb = openDatabase(path.join(tmp, 'import-update.db'))
  const u1 = cmd.createProduct(udb, { sku_code: 'UPD-1', category: '鱼竿', brand: '老品牌', model: '老型号', cost_price: 1000, suggest_price: 2000 })
  cmd.createInbound(udb, { productId: u1.id, quantity: 10, costPrice: 1000, operator: '测试' })
  const uProd = () => udb.prepare('SELECT * FROM products WHERE id = ?').get(u1.id)
  const uStock = () => udb.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_batches WHERE product_id = ?').get(u1.id).q

  const res = cmd.importBatch(udb, {
    mode: 'update',
    rows: [
      { sku_code: 'UPD-1', category: '鱼竿', brand: '新品牌', model: '新型号', cost_price: 1200, suggest_price: 2500, quantity: 99, color: '红', operator: '测试' },
      { sku_code: 'UPD-NEW', category: '鱼线', brand: '新货', cost_price: 300, quantity: 5, operator: '测试' },
      { sku_code: 'UPD-1', category: '鱼竿', brand: '再改', cost_price: 9999, quantity: 1, operator: '测试' }, // 文件内重复 → 跳过
    ],
  })
  ok('update 模式计数：新增 1 / 更新 1 / 跳过 1', res.imported === 1 && res.updated === 1 && res.skipped === 1)
  ok('update 模式更新可写字段',
    uProd().brand === '新品牌' && uProd().model === '新型号' &&
      uProd().cost_price === 1200 && uProd().suggest_price === 2500 && uProd().color === '红')
  ok('update 模式 SKU 不动', uProd().sku_code === 'UPD-1')
  ok('update 模式库存不动（不入新批次）', uStock() === 10)
  ok('update 模式新 SKU 照常导入并入库',
    udb.prepare("SELECT COUNT(*) AS n FROM inventory_batches b JOIN products p ON p.id = b.product_id WHERE p.sku_code = 'UPD-NEW' AND b.quantity = 5").get().n === 1)
  const updLog = cmd.auditLog(udb, { action: 'Excel更新' })
  ok('Excel 更新记一条日志', updLog.length === 1 && updLog[0].entity.includes('1 个商品'))

  // 留空的列保持原值不覆盖
  cmd.importBatch(udb, { mode: 'update', rows: [{ sku_code: 'UPD-1', category: '鱼竿', cost_price: 1300, quantity: 1 }] })
  ok('update 模式空列不覆盖原值',
    uProd().brand === '新品牌' && uProd().model === '新型号' && uProd().cost_price === 1300 && uProd().suggest_price === 2500)

  // 默认模式（不传 mode）仍是跳过，向后兼容
  const resSkip = cmd.importBatch(udb, { rows: [{ sku_code: 'UPD-1', category: '鱼竿', brand: '别改我', cost_price: 1, quantity: 1 }] })
  ok('默认 skip 模式：老 SKU 跳过不更新',
    resSkip.imported === 0 && resSkip.updated === 0 && resSkip.skipped === 1 && uProd().brand === '新品牌')
  let modeErr = null
  try { cmd.importBatch(udb, { mode: 'overwrite', rows: [] }) } catch (e) { modeErr = e }
  ok('非法导入模式拒绝', modeErr !== null)
  udb.close()
}

// 39. product:batchUpdate 通道注册检查（main.js + preload 白名单）
ok('main.js 注册 product:batchUpdate 通道', mainSrc.includes("'product:batchUpdate'"))
ok('preload 白名单含 product:batchUpdate', preloadSrc.includes("'product:batchUpdate'"))

// 40. 收款方式（pay_method）：出库/退货落库 + 校验 + 日结拆分 + 手机端透传
{
  const mdb = openDatabase(path.join(tmp, 'paymethod.db'))
  // 新库自带 pay_method 列
  ok('新库 transactions 带 pay_method 列',
    mdb.prepare('PRAGMA table_info(transactions)').all().some((c) => c.name === 'pay_method'))
  const mp = cmd.createProduct(mdb, { sku_code: '', category: '鱼竿', cost_price: 4000 })
  cmd.createInbound(mdb, { productId: mp.id, quantity: 10, costPrice: 4000, operator: '测试' })

  // 非法方式拒绝
  let pmErr = null
  try { cmd.confirmOutbound(mdb, { productId: mp.id, quantity: 1, sellingPrice: 8000, payMethod: '花呗' }) } catch (e) { pmErr = e }
  ok('非法收款方式拒绝', pmErr !== null && pmErr.message.includes('现金'))

  // 全额收款：方式落库
  cmd.confirmOutbound(mdb, { productId: mp.id, quantity: 2, sellingPrice: 8000, payMethod: '微信', operator: '测试' })
  const txFull = mdb.prepare("SELECT * FROM transactions WHERE type = 'out' ORDER BY id DESC LIMIT 1").get()
  ok('全额收款方式落库', txFull.pay_method === '微信' && txFull.paid_amount === null)

  // 部分付款：方式落库且实收分摊
  const mcust = cmd.createCustomer(mdb, { name: '方式客户' })
  cmd.confirmOutbound(mdb, { productId: mp.id, quantity: 1, sellingPrice: 8000, customerId: mcust.id, paidAmount: 3000, payMethod: '支付宝', operator: '测试' })
  const txPart = mdb.prepare("SELECT * FROM transactions WHERE type = 'out' ORDER BY id DESC LIMIT 1").get()
  ok('部分付款方式落库', txPart.pay_method === '支付宝' && txPart.paid_amount === 3000)

  // 纯赊账：方式强制落空（没有现金移动）
  cmd.confirmOutbound(mdb, { productId: mp.id, quantity: 1, sellingPrice: 8000, customerId: mcust.id, paidAmount: 0, payMethod: '现金', operator: '测试' })
  const txCredit = mdb.prepare("SELECT * FROM transactions WHERE type = 'out' ORDER BY id DESC LIMIT 1").get()
  ok('纯赊账方式强制落空', txCredit.pay_method === null && txCredit.paid_amount === 0)

  // 不传方式：NULL=未记录（向后兼容）
  cmd.confirmOutbound(mdb, { productId: mp.id, quantity: 1, sellingPrice: 8000, operator: '测试' })
  ok('不传方式记 NULL（未记录）', mdb.prepare("SELECT pay_method FROM transactions ORDER BY id DESC LIMIT 1").get().pay_method === null)

  // 退货：真退钱记方式；冲减欠款不记
  cmd.createReturn(mdb, { productId: mp.id, quantity: 1, refundPrice: 8000, payMethod: '微信', operator: '测试' })
  ok('退货退款方式落库', mdb.prepare("SELECT pay_method FROM transactions WHERE type = 'return' ORDER BY id DESC LIMIT 1").get().pay_method === '微信')
  cmd.createReturn(mdb, { productId: mp.id, quantity: 1, refundPrice: 8000, customerId: mcust.id, payMethod: '现金', operator: '测试' })
  ok('冲减欠款的退货方式落空', mdb.prepare("SELECT pay_method FROM transactions WHERE type = 'return' ORDER BY id DESC LIMIT 1").get().pay_method === null)
  let rmErr = null
  try { cmd.createReturn(mdb, { productId: mp.id, quantity: 1, refundPrice: 100, payMethod: '刷卡' }) } catch (e) { rmErr = e }
  ok('非法退款方式拒绝', rmErr !== null)

  // 日结拆分：微信 2×8000 − 退 1×8000 = 8000；支付宝 3000；赊账 (8000−3000)+8000=13000
  // 未记录 = 本测试 8000 + 种子今日无方式出库额（从 SEED_TRANSACTIONS 推导，出库售价×数量求和）
  const seedTodayUnrec = SEED_TRANSACTIONS
    .filter((tx) => tx[6] === 0 && tx[2] === 'out' && tx[5] != null)
    .reduce((s, t) => s + t[5] * t[3], 0)
  const split = cmd.todayPaymentSplit(mdb)
  ok('拆分：微信净额', split.byMethod['微信'] === 8000)
  ok('拆分：支付宝实收', split.byMethod['支付宝'] === 3000)
  ok('拆分：未记录净额', split.unrecorded === 8000 + seedTodayUnrec)
  ok('拆分：今日新增赊账', split.credit === 13000)

  // 手机端：payMethod 透传 + summary 带 payments
  const mDir = path.join(tmp, 'srv-pm')
  const srvM = createInventoryServer({ db: mdb, dataDir: mDir, basePort: 0 })
  const stM = await srvM.start()
  const mBase = `http://127.0.0.1:${stM.port}`
  const mToken = fs.readFileSync(path.join(mDir, 'server-token.txt'), 'utf8').trim()
  // 显式传售价：mp 没设建议零售价，省略会记 NULL 价格，不进日结拆分
  const rPm = await fetch(`${mBase}/api/outbound?token=${mToken}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: mp.id, quantity: 1, sellingPrice: 8000, payMethod: '微信' }),
  })
  ok('手机开单 payMethod 透传', rPm.status === 200 && (await rPm.json()).ok === true)
  ok('手机开单方式落库', mdb.prepare("SELECT pay_method FROM transactions WHERE type = 'out' ORDER BY id DESC LIMIT 1").get().pay_method === '微信')
  const rBadPm = await fetch(`${mBase}/api/outbound?token=${mToken}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ productId: mp.id, quantity: 1, payMethod: '刷卡' }),
  })
  ok('手机开单非法方式 400', rBadPm.status === 400)
  const sumM = await (await fetch(`${mBase}/api/summary?token=${mToken}`)).json()
  ok('手机 summary 带 payments 拆分',
    sumM.payments && sumM.payments.byMethod['微信'] === 16000 && typeof sumM.payments.credit === 'number')
  await srvM.stop()
  mdb.close()
}

// 41. 销售渠道（channel）：首单北极星判据的前置 —— 补列 + 默认「线下」+ Shopee 必须显式传
//     为什么值得单独测：台账 line 25 的首单判据是 `type=out 且 amount>0 且 channel=Shopee`，
//     并自带「不得用 amount>0 顶替」的警告。这里把判据**两个方向**都验一遍：
//     没有 Shopee 单时必须为 0；真录一笔 Shopee 单后必须变 1（否则判据永远为 0，等于没有判据）。
{
  const cdb = openDatabase(path.join(tmp, 'channel.db'))

  // 口径单一事实源（db.js 建表/触发器、outbound.js 校验、迁移脚本都从这里取）
  const chMod = await import('../electron/channels.js')
  ok('channels.js 导出取值集合（含 线下/Shopee）与默认值「线下」',
    Array.isArray(chMod.CHANNELS) && chMod.CHANNELS.includes('线下') && chMod.CHANNELS.includes('Shopee') && chMod.DEFAULT_CHANNEL === '线下')
  ok('assertChannel 不传/空 → undefined（交给触发器兜默认）',
    chMod.assertChannel(undefined) === undefined && chMod.assertChannel('') === undefined)
  ok('assertChannel 非法值抛错并列出取值',
    (() => { try { chMod.assertChannel('淘宝'); return false } catch (e) { return e.message.includes('线下') && e.message.includes('Shopee') } })())

  ok('新库 transactions 带 channel 列',
    cdb.prepare('PRAGMA table_info(transactions)').all().some((c) => c.name === 'channel'))
  ok('新库已建渠道默认触发器 trg_transactions_channel_default',
    !!cdb.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_transactions_channel_default'").get())

  const cp = cmd.createProduct(cdb, { sku_code: '', category: '鱼竿', cost_price: 4000 })
  cmd.createInbound(cdb, { productId: cp.id, quantity: 10, costPrice: 4000, operator: '测试' })

  const crit = () => cdb.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out' AND selling_price > 0 AND channel='Shopee'").get().n
  const naive = () => cdb.prepare("SELECT COUNT(*) n FROM transactions WHERE type='out' AND selling_price > 0").get().n

  cmd.confirmOutbound(cdb, { productId: cp.id, quantity: 1, sellingPrice: 8000, operator: '测试' })
  ok('不传渠道 → 落库为「线下」（数据库层触发器兜默认）',
    cdb.prepare("SELECT channel FROM transactions WHERE type='out' ORDER BY id DESC LIMIT 1").get().channel === '线下')
  ok('此时首单判据为 0（线下的单不满足 渠道=Shopee）', crit() === 0)
  ok('对照：去掉渠道条件则 >0 —— 这正是「不得用 amount>0 顶替」要挡的', naive() > 0)

  cmd.confirmOutbound(cdb, { productId: cp.id, quantity: 1, sellingPrice: 9000, channel: 'Shopee', operator: '测试' })
  ok('显式 channel=Shopee 落库且不被触发器覆盖',
    cdb.prepare("SELECT channel FROM transactions WHERE type='out' ORDER BY id DESC LIMIT 1").get().channel === 'Shopee')
  ok('录到 Shopee 单后首单判据变 1（判据两个方向都成立，不是永远为 0）', crit() === 1)

  let chErr = null
  try { cmd.confirmOutbound(cdb, { productId: cp.id, quantity: 1, sellingPrice: 8000, channel: '淘宝', operator: '测试' }) } catch (e) { chErr = e }
  ok('非法渠道拒绝', chErr !== null && chErr.message.includes('渠道'))

  ok('入库单 channel 保持 NULL（渠道只对销售有意义）',
    cdb.prepare("SELECT channel FROM transactions WHERE type='in' ORDER BY id DESC LIMIT 1").get().channel === null)

  // ---- 多品开单（收银台 confirmCheckout）是主路径：只改单品出库会漏掉最常见的开单方式 ----
  ok('（前置）此时首单判据为 1', crit() === 1)

  cmd.confirmCheckout(cdb, { items: [{ productId: cp.id, quantity: 2, sellingPrice: 8000 }], operator: '测试' })
  ok('多品开单不传渠道 → 落「线下」',
    cdb.prepare("SELECT channel FROM transactions WHERE type='out' ORDER BY id DESC LIMIT 1").get().channel === '线下')
  ok('多品开单走线下不顶替首单判据（仍为 1）', crit() === 1)

  cmd.confirmCheckout(cdb, { items: [{ productId: cp.id, quantity: 1, sellingPrice: 9500 }], channel: 'Shopee', operator: '测试' })
  ok('多品开单显式 Shopee → 落库且不被触发器覆盖',
    cdb.prepare("SELECT channel FROM transactions WHERE type='out' ORDER BY id DESC LIMIT 1").get().channel === 'Shopee')
  ok('多品开单的 Shopee 单计入首单判据（变 2）', crit() === 2)

  let ccErr = null
  try { cmd.confirmCheckout(cdb, { items: [{ productId: cp.id, quantity: 1, sellingPrice: 8000 }], channel: '淘宝', operator: '测试' }) } catch (e) { ccErr = e }
  ok('多品开单非法渠道拒绝', ccErr !== null && ccErr.message.includes('渠道'))

  // 无库存强行出库走的是另一条 INSERT（batch_id=NULL），渠道也必须带上
  cmd.confirmCheckout(cdb, { items: [{ productId: cp.id, quantity: 999, sellingPrice: 8000 }], channel: 'Shopee', operator: '测试', allowNoStock: true })
  const noStockRow = cdb.prepare("SELECT channel, batch_id FROM transactions WHERE type='out' AND batch_id IS NULL ORDER BY id DESC LIMIT 1").get()
  ok('无库存强行出库那条流水也带渠道（两条 INSERT 都补到了）',
    noStockRow != null && noStockRow.batch_id === null && noStockRow.channel === 'Shopee')

  cdb.close()
}

// 41. 一单多商品收银台（confirmCheckout）：通道注册 + 校验 + 原子性 + 赊账摊销 + 方式落库
ok('main.js 注册 outbound:checkout 通道', mainSrc.includes("'outbound:checkout'"))
ok('preload 白名单含 outbound:checkout', preloadSrc.includes("'outbound:checkout'"))
{
  const cdb = openDatabase(path.join(tmp, 'checkout.db'))
  const cp1 = cmd.createProduct(cdb, { sku_code: '', category: '鱼竿', cost_price: 1000 })
  const cp2 = cmd.createProduct(cdb, { sku_code: '', category: '鱼线', cost_price: 500 })
  cmd.createInbound(cdb, { productId: cp1.id, quantity: 5, costPrice: 1000, operator: '测试' })
  cmd.createInbound(cdb, { productId: cp2.id, quantity: 3, costPrice: 500, operator: '测试' })

  // 校验链：空列表 / 超 50 行 / 售价 ≤0 / 实收超应付 / 赊账不选客户 / 非法方式
  let e1 = null
  try { cmd.confirmCheckout(cdb, { items: [] }) } catch (e) { e1 = e }
  ok('收银台空列表拒绝', e1 !== null)
  let e2 = null
  try { cmd.confirmCheckout(cdb, { items: Array.from({ length: 51 }, () => ({ productId: cp1.id, quantity: 1, sellingPrice: 100 })) }) } catch (e) { e2 = e }
  ok('收银台超 50 行拒绝', e2 !== null && e2.message.includes('50'))
  let e3 = null
  try { cmd.confirmCheckout(cdb, { items: [{ productId: cp1.id, quantity: 1, sellingPrice: 0 }] }) } catch (e) { e3 = e }
  ok('收银台售价必须大于 0', e3 !== null && e3.message.includes('售价'))
  let e4 = null
  try { cmd.confirmCheckout(cdb, { items: [{ productId: cp1.id, quantity: 1, sellingPrice: 1000 }], paidAmount: 1001 }) } catch (e) { e4 = e }
  ok('收银台实收超应付拒绝', e4 !== null)
  let e5 = null
  try { cmd.confirmCheckout(cdb, { items: [{ productId: cp1.id, quantity: 1, sellingPrice: 1000 }], paidAmount: 500 }) } catch (e) { e5 = e }
  ok('收银台赊账必须选客户', e5 !== null && e5.message.includes('客户'))
  let e6 = null
  try { cmd.confirmCheckout(cdb, { items: [{ productId: cp1.id, quantity: 1, sellingPrice: 100 }], payMethod: '刷卡' }) } catch (e) { e6 = e }
  ok('收银台非法方式拒绝', e6 !== null)

  // 多样一单全额收款：两商品 2×2000 + 1×800 = 4800，库存按 FIFO 扣，方式逐行落库
  const r1 = cmd.confirmCheckout(cdb, {
    items: [
      { productId: cp1.id, quantity: 2, sellingPrice: 2000 },
      { productId: cp2.id, quantity: 1, sellingPrice: 800 },
    ],
    payMethod: '微信',
    operator: '测试',
  })
  ok('收银台多样一单成交', r1.ok === true && r1.totalDue === 4800 && r1.creditAmount === 0)
  const stock1 = cdb.prepare('SELECT COALESCE(SUM(quantity),0) s FROM inventory_batches WHERE product_id = ?').get(cp1.id).s
  const stock2 = cdb.prepare('SELECT COALESCE(SUM(quantity),0) s FROM inventory_batches WHERE product_id = ?').get(cp2.id).s
  ok('收银台库存按行扣减', stock1 === 3 && stock2 === 2)
  const coTxs = cdb.prepare("SELECT * FROM transactions WHERE type = 'out' ORDER BY id DESC LIMIT 2").all()
  ok('收银台流水逐行落库且方式一致', coTxs.length === 2 && coTxs.every((t) => t.pay_method === '微信' && t.paid_amount === null))

  // 原子性：其中一样库存不够 → 整单回滚，库存和流水都不动
  const beforeTx = cdb.prepare('SELECT COUNT(*) n FROM transactions').get().n
  const r2 = cmd.confirmCheckout(cdb, {
    items: [
      { productId: cp1.id, quantity: 1, sellingPrice: 2000 },
      { productId: cp2.id, quantity: 99, sellingPrice: 800 },
    ],
    operator: '测试',
  })
  ok('收银台缺货整单拒绝', r2.ok === false && r2.shortages.length === 1 && r2.shortages[0].productId === cp2.id && r2.shortages[0].shortage === 97)
  const afterTx = cdb.prepare('SELECT COUNT(*) n FROM transactions').get().n
  const stock1After = cdb.prepare('SELECT COALESCE(SUM(quantity),0) s FROM inventory_batches WHERE product_id = ?').get(cp1.id).s
  ok('收银台回滚不留半截', afterTx === beforeTx && stock1After === 3)

  // 赊账：两样一单付一部分（应付 2800 实收 1500），实收按行顺序摊销，欠款 1300
  const ccust = cmd.createCustomer(cdb, { name: '收银客户' })
  const r3 = cmd.confirmCheckout(cdb, {
    items: [
      { productId: cp1.id, quantity: 1, sellingPrice: 2000 },
      { productId: cp2.id, quantity: 1, sellingPrice: 800 },
    ],
    customerId: ccust.id,
    paidAmount: 1500,
    payMethod: '现金',
    operator: '测试',
  })
  ok('收银台部分付款成交', r3.ok === true && r3.totalDue === 2800 && r3.paidAmount === 1500 && r3.creditAmount === 1300)
  const apportioned = cdb.prepare("SELECT paid_amount FROM transactions WHERE type = 'out' AND customer_id = ? ORDER BY id DESC LIMIT 2").all(ccust.id)
  // 行1（cp1 应付 2000）先摊满 1500，行2（cp2）摊到 0
  ok('收银台实收按行摊销', apportioned.some((t) => t.paid_amount === 1500) && apportioned.some((t) => t.paid_amount === 0))

  // 纯赊账：没有现金移动，方式强制落空
  const r4 = cmd.confirmCheckout(cdb, {
    items: [{ productId: cp1.id, quantity: 1, sellingPrice: 2000 }],
    customerId: ccust.id,
    paidAmount: 0,
    payMethod: '现金',
    operator: '测试',
  })
  ok('收银台纯赊账成交', r4.ok === true && r4.creditAmount === 2000)
  const pureTx = cdb.prepare("SELECT pay_method FROM transactions WHERE type = 'out' ORDER BY id DESC LIMIT 1").get()
  ok('收银台纯赊账方式落空', pureTx.pay_method === null)

  // 审计：一单一条「收银开单」日志，含总额
  const auditRow = cdb.prepare("SELECT * FROM audit_log WHERE action = '收银开单' ORDER BY id DESC LIMIT 1").get()
  ok('收银台审计留痕', auditRow !== undefined && auditRow.detail.includes('totalDue'))

  cdb.close()
}

// 42. 局域网整机共享（方案 A）：/app 托管桌面网页版 + POST /api/invoke 通用调用接口
{
  const adb = openDatabase(path.join(tmp, 'lanapp.db'))
  const aDir = path.join(tmp, 'srva')
  // 假 webRoot：一个 index.html + 一个静态资源
  const webRoot = path.join(tmp, 'webroot')
  fs.mkdirSync(path.join(webRoot, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>渔具库存桌面版</title><div id="root"></div>')
  fs.writeFileSync(path.join(webRoot, 'assets', 'app.css'), 'body{margin:0}')
  fs.writeFileSync(path.join(webRoot, 'assets', 'app.js'), 'console.log(1)')

  const srvA = createInventoryServer({ db: adb, dataDir: aDir, basePort: 0, webRoot })
  const stA = await srvA.start()
  const aBase = `http://127.0.0.1:${stA.port}`
  const aToken = fs.readFileSync(path.join(aDir, 'server-token.txt'), 'utf8').trim()

  // 状态含全功能版地址
  ok('状态含 appUrl（/app?token=）', typeof stA.appUrl === 'string' && stA.appUrl.includes(`/app?token=${aToken}`))

  // /app 托管：index.html / 静态资源 MIME / 404 / 防穿越
  const rApp = await fetch(`${aBase}/app`)
  const appHtml = await rApp.text()
  ok('GET /app 返回桌面版 index.html', rApp.status === 200 && appHtml.includes('渔具库存桌面版'))
  ok('/app 响应带 CSP 头', (rApp.headers.get('content-security-policy') ?? '').includes("default-src 'self'"))
  const rCss = await fetch(`${aBase}/app/assets/app.css`)
  ok('静态资源 MIME 正确（css）', rCss.status === 200 && (rCss.headers.get('content-type') ?? '').includes('text/css'))
  const rJs = await fetch(`${aBase}/app/assets/app.js`)
  ok('静态资源 MIME 正确（js）', rJs.status === 200 && (rJs.headers.get('content-type') ?? '').includes('javascript'))
  const rMissing = await fetch(`${aBase}/app/assets/nope.js`)
  ok('不存在的静态资源 404', rMissing.status === 404)
  const rTrav = await fetch(`${aBase}/app/%2e%2e/server-token.txt`)
  ok('编码路径穿越读不到 token 文件（404）', rTrav.status === 404)

  // POST /api/invoke：鉴权 / CT / 体格式 / 白名单 / 读通道 / 写通道 / 业务错误中文透传
  const rInvNoToken = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  ok('invoke 无 token 返回 401', rInvNoToken.status === 401)
  const rInvBadCt = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'x-token': aToken }, body: '{}',
  })
  ok('invoke 非 JSON Content-Type 返回 415', rInvBadCt.status === 415)
  const rInvBadJson = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken }, body: '{bad',
  })
  ok('invoke 非法 JSON 返回 400', rInvBadJson.status === 400)
  const rInvUnknown = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'tts:speak', payload: {} }),
  })
  ok('invoke 未开放通道返回 404（主机本地能力不开放）', rInvUnknown.status === 404)
  const rInvLoad = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'data:loadAll', payload: {} }),
  })
  const invLoad = await rInvLoad.json()
  ok('invoke data:loadAll 返回全量数据', rInvLoad.status === 200 && invLoad.ok === true && Array.isArray(invLoad.result.products))
  const rInvCreate = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'product:create', payload: { sku_code: '', category: '鱼钩', cost_price: 100 } }),
  })
  const invCreate = await rInvCreate.json()
  ok('invoke product:create 写入成功', rInvCreate.status === 200 && invCreate.ok === true
    && adb.prepare('SELECT COUNT(*) n FROM products WHERE id = ?').get(invCreate.result?.id ?? -1).n === 1)
  const rInvBizErr = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'outbound:checkout', payload: { items: [{ productId: 1, quantity: 1, sellingPrice: 0 }] } }),
  })
  const invBizErr = await rInvBizErr.json()
  ok('invoke 业务校验错误 400 且中文提示透传', rInvBizErr.status === 400 && typeof invBizErr.error === 'string' && invBizErr.error.includes('售价'))

  // v2.1.10 手机端补全通道：临期 / 报损 / 配节 / 套装 + 热销带 unit（按米卖鱼线依赖）
  const rExpiring = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'product:expiring', payload: { days: 30 } }),
  })
  ok('invoke product:expiring 返回数组', rExpiring.status === 200 && Array.isArray((await rExpiring.json()).result))
  const rPc2 = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'product:create', payload: { sku_code: '', category: '饵料', cost_price: 200, unit: '件' } }),
  })
  const pc2 = await rPc2.json()
  const pid2 = pc2.result?.id
  const rIn2 = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'inbound:create', payload: { productId: pid2, quantity: 10, costPrice: 200 } }),
  })
  ok('invoke inbound:create 给报损备货', rIn2.status === 200 && (await rIn2.json()).ok === true)
  const rWaste = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'waste:create', payload: { productId: pid2, quantity: 3, reason: '临期报废', operator: '手机' } }),
  })
  const waste = await rWaste.json()
  ok('invoke waste:create 报损成功', rWaste.status === 200 && waste.ok === true)
  const rWasteList = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'waste:list', payload: { limit: 10 } }),
  })
  const wasteList = await rWasteList.json()
  ok('invoke waste:list 能看到刚才的报损', rWasteList.status === 200 && Array.isArray(wasteList.result) && wasteList.result.some((w) => w.product_id === pid2))
  const rPart = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'part:set', payload: { productId: pid2, parentId: invCreate.result.id, partType: '竿梢', operator: '手机' } }),
  })
  ok('invoke part:set 设配节', rPart.status === 200 && (await rPart.json()).ok === true)
  const rPartAll = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'part:all', payload: {} }),
  })
  const partAll = await rPartAll.json()
  ok('invoke part:all 含配节与主竿名', rPartAll.status === 200 && Array.isArray(partAll.result) && partAll.result.some((p) => p.id === pid2 && p.parent_name))
  const rKit = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'kit:save', payload: { name: '新手绑钩套装', items: [{ productId: pid2, quantity: 2 }] } }),
  })
  const kit = await rKit.json()
  ok('invoke kit:save 建套装', rKit.status === 200 && kit.result?.id > 0)
  const rKitList = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'kit:list', payload: {} }),
  })
  const kitList = await rKitList.json()
  ok('invoke kit:list 能看到套装', rKitList.status === 200 && Array.isArray(kitList.result) && kitList.result.some((k) => k.id === kit.result?.id))
  // 热销榜：开一笔真实出库，验证返回项带 unit（手机端按米卖鱼线全靠它判断单位）
  const rOut2 = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'outbound:checkout', payload: { items: [{ productId: pid2, quantity: 1, sellingPrice: 500 }], method: '现金', operator: '手机' } }),
  })
  ok('invoke outbound:checkout 开单成功（热销备数据）', rOut2.status === 200 && (await rOut2.json()).ok === true)
  const rHot = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'report:hotSellers', payload: { days: 30 } }),
  })
  const hot = await rHot.json()
  ok('invoke report:hotSellers 每项带 unit 字段', rHot.status === 200 && Array.isArray(hot.result) && hot.result.every((p) => 'unit' in p))
  // 按米卖鱼线（手机端核心场景）：米商品建/入/出全走 invoke，小数开单
  const rMeter = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'product:create', payload: { sku_code: '', category: '鱼线', cost_price: 800, unit: '米' } }),
  })
  const meterProd = await rMeter.json()
  const meterId = meterProd.result?.id
  const rMeterIn = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'inbound:create', payload: { productId: meterId, quantity: 100, costPrice: 800 } }),
  })
  ok('米商品按米入库成功', rMeterIn.status === 200 && (await rMeterIn.json()).ok === true)
  const rMeterOut = await fetch(`${aBase}/api/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-token': aToken },
    body: JSON.stringify({ channel: 'outbound:checkout', payload: { items: [{ productId: meterId, quantity: 15.5, sellingPrice: 1200 }], payMethod: '现金', operator: '手机' } }),
  })
  const meterOut = await rMeterOut.json()
  ok('米商品按米卖出 15.5 米成功', rMeterOut.status === 200 && meterOut.ok === true)
  const meterStock = adb.prepare('SELECT COALESCE(SUM(quantity),0) q FROM inventory_batches WHERE product_id = ?').get(meterId).q
  ok('米商品出库后库存扣减正确（100-15.5=84.5）', Math.abs(meterStock - 84.5) < 1e-9)
  await srvA.stop()

  // 不传 webRoot 的实例：/app 404、appUrl 为 null（开发态/未打包环境）
  const srvNoWeb = createInventoryServer({ db: adb, dataDir: path.join(tmp, 'srvb'), basePort: 0 })
  const stNoWeb = await srvNoWeb.start()
  ok('无 webRoot 时 appUrl 为 null', stNoWeb.appUrl === null)
  const rApp404 = await fetch(`http://127.0.0.1:${stNoWeb.port}/app`)
  ok('无 webRoot 时 /app 返回 404', rApp404.status === 404)
  await srvNoWeb.stop()

  adb.close()
}

// 43. 支出记账（v1.10）：expenses 表 + 记/改/删/查 + 校验链 + loadAll + 通道注册 + LAN 开放
ok('main.js 注册 expense 三通道',
  mainSrc.includes("'expense:create'") && mainSrc.includes("'expense:update'") && mainSrc.includes("'expense:delete'"))
ok('preload 白名单含 expense 三通道',
  preloadSrc.includes("'expense:create'") && preloadSrc.includes("'expense:update'") && preloadSrc.includes("'expense:delete'"))
{
  const serverSrc2 = fs.readFileSync(path.resolve('electron/server.js'), 'utf8')
  ok('LAN invoke 白名单开放 expense 通道', serverSrc2.includes("'expense:create'"))
}
{
  const edb = openDatabase(path.join(tmp, 'expense.db'))
  const esup = cmd.createSupplier(edb, { name: '支出测试供应商' })

  // 记一笔：供应商名 JOIN 带出，日期默认今天（本地）
  const e1 = cmd.createExpense(edb, { category: '进货付款', amount: 500000, method: '支付宝', supplierId: esup.id, note: '尾款', operator: '测试' })
  ok('记支出返回完整行（含供应商名）', e1.id > 0 && e1.supplier_name === '支出测试供应商' && e1.amount === 500000)
  ok('支出日期默认今天（YYYY-MM-DD）', /^\d{4}-\d{2}-\d{2}$/.test(e1.expense_date))
  cmd.createExpense(edb, { category: '房租', amount: 280000, method: '现金', expenseDate: '2026-06-01' })
  cmd.createExpense(edb, { category: '运费', amount: 3500, method: '微信', expenseDate: '2026-06-15' })

  // 校验链：坏分类 / 零金额 / 负金额 / 坏方式 / 坏日期 / 供应商不存在
  let x1 = null
  try { cmd.createExpense(edb, { category: '旅游', amount: 100, method: '现金' }) } catch (e) { x1 = e }
  ok('非法分类拒绝', x1 !== null && x1.message.includes('分类'))
  let x2 = null
  try { cmd.createExpense(edb, { category: '房租', amount: 0, method: '现金' }) } catch (e) { x2 = e }
  ok('零金额拒绝', x2 !== null && x2.message.includes('金额'))
  let x3 = null
  try { cmd.createExpense(edb, { category: '房租', amount: 100, method: '刷卡' }) } catch (e) { x3 = e }
  ok('非法方式拒绝', x3 !== null && x3.message.includes('方式'))
  let x4 = null
  try { cmd.createExpense(edb, { category: '房租', amount: 100, method: '现金', expenseDate: '昨天' }) } catch (e) { x4 = e }
  ok('非法日期拒绝', x4 !== null && x4.message.includes('日期'))
  let x5 = null
  try { cmd.createExpense(edb, { category: '进货付款', amount: 100, method: '现金', supplierId: 999 }) } catch (e) { x5 = e }
  ok('供应商不存在拒绝', x5 !== null && x5.message.includes('供应商'))

  // 改：字段全量替换 + 审计留痕
  const e1u = cmd.updateExpense(edb, { id: e1.id, category: '房租', amount: 260000, method: '微信', expenseDate: '2026-07-05', note: '改后' })
  ok('改支出生效', e1u.category === '房租' && e1u.amount === 260000 && e1u.supplier_id === null && e1u.note === '改后')
  let x6 = null
  try { cmd.updateExpense(edb, { id: 999, category: '房租', amount: 100, method: '现金' }) } catch (e) { x6 = e }
  ok('改不存在的支出拒绝', x6 !== null && x6.message.includes('不存在'))

  // 查：区间 / 分类筛选
  const jun = cmd.listExpenses(edb, { from: '2026-06-01', to: '2026-06-30' })
  ok('按日期区间筛选', jun.length === 2 && jun.every((r) => r.expense_date.startsWith('2026-06')))
  const rent = cmd.listExpenses(edb, { category: '房租' })
  ok('按分类筛选', rent.length === 2 && rent.every((r) => r.category === '房租'))
  let x7 = null
  try { cmd.listExpenses(edb, { category: '旅游' }) } catch (e) { x7 = e }
  ok('查询非法分类也拒绝', x7 !== null)

  // loadAll 带支出
  const allE = cmd.loadAll(edb)
  ok('loadAll 含 expenses', Array.isArray(allE.expenses) && allE.expenses.length === 3)

  // 删 + 审计三种动作齐全
  cmd.deleteExpense(edb, { id: e1.id, operator: '测试' })
  ok('删支出生效', cmd.listExpenses(edb, { category: '房租' }).length === 1)
  let x8 = null
  try { cmd.deleteExpense(edb, { id: e1.id }) } catch (e) { x8 = e }
  ok('重复删除拒绝', x8 !== null && x8.message.includes('不存在'))
  const acts = edb.prepare("SELECT DISTINCT action FROM audit_log WHERE action IN ('记支出','改支出','删支出')").all().map((r) => r.action)
  ok('支出三种动作都留审计', acts.length === 3)

  edb.close()
}

// 44. 扫码直达开单（贴纸二维码）：手机页 deepBarcode 处理 + 库存搜索带 barcode 字段
{
  const serverSrc3 = fs.readFileSync(path.resolve('electron/server.js'), 'utf8')
  ok('手机页解析 barcode 参数（扫码直达开单）', serverSrc3.includes("pageParams.get('barcode')") && serverSrc3.includes('deepBarcode'))
  ok('手机页扫码后自动锁定商品开单', serverSrc3.includes('doSellSearch(deepBarcode, true)') && serverSrc3.includes('autoPick'))

  const qdb = openDatabase(path.join(tmp, 'qr.db'))
  cmd.createProduct(qdb, { sku_code: '', barcode: '6901234567890', category: '鱼竿', cost_price: 100 })
  const qDir = path.join(tmp, 'srvq')
  const srvQ = createInventoryServer({ db: qdb, dataDir: qDir, basePort: 0 })
  const stQ = await srvQ.start()
  const qToken = fs.readFileSync(path.join(qDir, 'server-token.txt'), 'utf8').trim()
  const items = await (await fetch(`http://127.0.0.1:${stQ.port}/api/inventory?token=${qToken}&q=6901234`)).json()
  ok('库存搜索按条码前缀命中且返回 barcode 字段', items.length === 1 && items[0].barcode === '6901234567890')
  await srvQ.stop()
  qdb.close()
}

// 45. M3 数据加固：AI 兜底口径断言 + AI 动作审计留痕 + 备份三份一致性
{
  // ---- 45.1 AI 兜底口径断言：纠错必映射到已存在商品（兜底口径=主路径口径，不凭空造名） ----
  const names = ['达亿瓦 SP', '喜玛诺 2000', '赤刃 4号']
  const exact = localFuzzyMatch('达亿瓦 SP', names)
  ok('本地匹配·精确命中返回原 label', exact && exact.method === 'exact' && exact.name === '达亿瓦 SP')
  const typo = localFuzzyMatch('达亿瓦 S', names)
  ok('本地匹配·打错字纠错映射到已存在商品（口径=不凭空造名）', typo && names.includes(typo.name))
  const nonsense = localFuzzyMatch('zzzqqqxyz', names)
  ok('本地匹配·完全无关返回无命中（不硬凑）', nonsense === null)
  const onlyReal = localFuzzyMatch('喜玛', names)
  ok('本地匹配·候选永远来自传入商品名清单', onlyReal && names.includes(onlyReal.name))

  // ---- 45.2 AI 动作审计留痕：logAudit 写入 audit_log + orchestrator 静态埋点检查 ----
  const audDb = openDatabase(path.join(tmp, 'audit-ai.db'))
  logAudit(audDb, 'AI纠错搜索', 'product', { text: '达亿瓦 S', corrected: '达亿瓦 SP', source: 'local:brand-contains' }, 'AI')
  const audRow = audDb.prepare("SELECT * FROM audit_log WHERE action = 'AI纠错搜索' ORDER BY id DESC LIMIT 1").get()
  ok('AI 动作审计写入 audit_log（action/entity/operator 齐全）', audRow && audRow.action === 'AI纠错搜索' && audRow.entity === 'product' && audRow.operator === 'AI')
  const audJson = JSON.parse(audRow.detail)
  ok('AI 审计 detail 记录纠错前后文案', audJson && audJson.text === '达亿瓦 S' && audJson.corrected === '达亿瓦 SP')
  audDb.close()
  const orcSrc = fs.readFileSync(path.resolve('electron/ai-orchestrator.js'), 'utf8')
  ok('orchestrator 源码含 AI 纠错/识别审计埋点', orcSrc.includes("logAudit(db, 'AI纠错搜索'") && orcSrc.includes("logAudit(db, 'AI拍照识别'"))

  // ---- 45.3 备份三份一致性：主备份 + 第二位置副本一致（三份=本地主/第二位置/云，云走同步链路） ----
  const b3DbPath = path.join(tmp, 'bak3.db')
  const b3Db = openDatabase(b3DbPath)
  cmd.createProduct(b3Db, { sku_code: 'BK3-1', barcode: '6900000000201', category: '工具配件', brand: '备份牌', model: 'X', cost_price: 100, suggest_price: 200, location: 'B区', status: '在售' })
  const b3Main = path.join(tmp, 'bak3-main')
  const b3Extra = path.join(tmp, 'bak3-extra')
  const b3File = backupNow(b3Db, b3DbPath, b3Main, b3Extra)
  const b3ExtraFile = path.join(b3Extra, path.basename(b3File))
  ok('主备份 + 第二位置 两份都存在', fs.existsSync(b3File) && fs.existsSync(b3ExtraFile))
  ok('两份备份字节一致（完整性校验，三份防丢）', fs.readFileSync(b3File).equals(fs.readFileSync(b3ExtraFile)))
  b3Db.close()
}

// 46. 中心库模式的通道缺口（2026-09-14 owner 反馈「设置里一堆功能不能用」）
//     背景：中心库模式下桌面端把非本机通道全发给中心库，而中心库上没有这些通道 → 404 unknown channel。
//     本段是**行为级**的：真起一个服务器，逐个 POST /api/invoke 打过去，断言"不再 404"。
//     同时守住写通道：只读（视图）令牌必须 403 —— 漏了就等于把员工/单位/知识库的写权限给了只读账号。
{
  const gdb = openDatabase(path.join(tmp, 'gapch.db'))
  const gDir = path.join(tmp, 'srvgap')
  const srvG = createInventoryServer({ db: gdb, dataDir: gDir, basePort: 0 })
  const stG = await srvG.start()
  const gBase = `http://127.0.0.1:${stG.port}`
  const gToken = fs.readFileSync(path.join(gDir, 'server-token.txt'), 'utf8').trim()
  const gView = fs.readFileSync(path.join(gDir, 'server-view-token.txt'), 'utf8').trim()

  const callG = async (channel, payload = {}, tk = gToken) => {
    const r = await fetch(`${gBase}/api/invoke`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-token': tk },
      body: JSON.stringify({ channel, payload }),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  // 46.1 这批以前是 404 —— 客户端每个都点过、每个都"没反应"
  const GAP_READ = ['ai:smartSearch', 'category:listWithCount', 'clearance:get', 'pricing:get', 'knowledge:list', 'template:list', 'unit:list', 'user:list', 'user:current', 'user:staffLoginEnabled']
  for (const ch of GAP_READ) {
    const { status, body } = await callG(ch, {})
    ok(`中心库通道 ${ch} 已开通且返回 ok`, status === 200 && body?.ok === true, `HTTP ${status} ${JSON.stringify(body).slice(0, 120)}`)
  }
  // 读通道要给出**真的数据形状**（不是"200 但空壳"）
  const rCnt = await callG('category:listWithCount')
  ok('category:listWithCount 返回数组（分类管理页要显示计数）', Array.isArray(rCnt.body?.result))
  const rTpl = await callG('template:list')
  ok('template:list 返回行业模板数组', Array.isArray(rTpl.body?.result))
  const rUsr = await callG('user:list')
  ok('user:list 返回员工数组', Array.isArray(rUsr.body?.result))
  const rKn = await callG('knowledge:list')
  ok('knowledge:list 返回数组', Array.isArray(rKn.body?.result))
  const rCl = await callG('clearance:get')
  ok('clearance:get 返回清仓建议对象', rCl.body?.result && typeof rCl.body.result === 'object' && 'items' in rCl.body.result)
  const rPr = await callG('pricing:get')
  ok('pricing:get 返回定价建议对象', rPr.body?.result && typeof rPr.body.result === 'object' && 'items' in rPr.body.result)
  // 搜索：服务端跑本地兜底口径（与桌面端共用 commands/search.js）
  const rSs = await callG('ai:smartSearch', { text: '' })
  ok('ai:smartSearch 空串返回 ok:false/empty（不是 404）', rSs.status === 200 && rSs.body?.result?.ok === false)
  const rSs2 = await callG('ai:smartSearch', { text: 'zzzqqqxyz' })
  ok('ai:smartSearch 有结果形状（source 字段在）', rSs2.status === 200 && typeof rSs2.body?.result?.source === 'string')

  // 46.2 写通道：普通令牌能调、**只读令牌必须 403**
  const GAP_WRITE = ['user:create', 'user:update', 'user:delete', 'user:setStaffLogin', 'unit:create', 'unit:update', 'unit:delete', 'unit:move', 'knowledge:save', 'knowledge:update', 'knowledge:delete', 'template:apply']
  for (const ch of GAP_WRITE) {
    const rw = await callG(ch, {})
    ok(`中心库写通道 ${ch} 已开通（不再 404）`, rw.status !== 404, `HTTP ${rw.status}`)
    const rv = await callG(ch, {}, gView)
    ok(`视图（只读）令牌调 ${ch} 必须 403`, rv.status === 403, `HTTP ${rv.status}`)
  }

  // 46.3 真做一遍：建单位 → 列表里有它（证明不是"通道在但没用"）
  await callG('unit:create', { name: '闸门测试单位', operator: 'gate' })
  const rUnits = await callG('unit:list')
  ok('经服务端新建的单位真的落进服务端账本', JSON.stringify(rUnits.body?.result ?? '').includes('闸门测试单位'))

  // 46.4 本机能力**不许**被开出去（回归：tts/kws/app 这些是"问本机"的）
  for (const ch of ['tts:speak', 'kws:status', 'app:info', 'server:status', 'feedback:send']) {
    const r = await callG(ch, {})
    ok(`本机通道 ${ch} 仍不开放给服务端（404）`, r.status === 404, `HTTP ${r.status}`)
  }

  await srvG.stop()
  gdb.close()
}

// 47. AI 简报（只算不推）的口径闸门 —— 锁住 2026-09-15 用真实数据当场证伪的那个 bug：
//     第一版把**所有 type='out'** 当动销，于是把"优选仓备货发货"（无售价、入 10 当天出 10）
//     算成了动销，给出 14 条**假补货建议**。这一段就是防它复发，以及防"数据不足"变成恒假闸门。
{
  const bdb = openDatabase(path.join(tmp, 'briefing.db'))
  cmd.createProduct(bdb, { sku_code: 'BR-1', category: '鱼钩', brand: '测试牌', model: '渠道款', cost_price: 100, suggest_price: 200, min_stock: 5, status: '在售' })
  const pid = bdb.prepare("SELECT id FROM products WHERE sku_code='BR-1'").get().id
  const ts = new Date().toISOString()
  const insTx = bdb.prepare("INSERT INTO transactions (product_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, channel, store_code) VALUES (?,?,?,?,?,?,?,?,?,?)")
  // 造一个"优选仓备货发货"：入库 10、当天无售价出库 10（第一版就是把它当成了动销）
  insTx.run(pid, 'in', 10, 0, null, ts, '优选仓发货-测试', null, null, '')
  insTx.run(pid, 'out', 10, 0, null, ts, '优选仓发货-测试', null, '优选仓', '')

  const brief1 = cmd.buildBriefing(bdb)
  ok('简报：无售价的渠道发货**不算**动销（第一版的假阳性不再出现）', brief1.restock.needs.length === 0, '该补货 ' + brief1.restock.needs.length + ' 条')
  ok('简报：这类商品进"渠道发货/不能替你决定"那一栏', brief1.counts.channelOnly + brief1.counts.lowButSlow >= 1)
  ok('简报：真实零售为 0 → 判定数据不足、不给出补货建议', brief1.data.enough === false && brief1.stance !== 'actionable')
  ok('简报：数据不足时头条说的是"为什么不出建议"，不是硬编一条', /没有足够|先修账/.test(brief1.headline), brief1.headline)

  // 造够真实零售（≥门槛）→ 闸门必须真的能过，否则"数据不足"就成了恒假
  for (let i = 0; i < 25; i++) insTx.run(pid, 'out', 1, 100, 200, ts, '店长', null, '线下', '')
  const brief2 = cmd.buildBriefing(bdb)
  ok('简报：真实零售够了以后，数据不足判定解除（闸门不是恒假）', brief2.data.enough === true, JSON.stringify(brief2.data.reasons))
  ok('简报：这时才给出该补货（低库存 ∩ 有真实零售）', brief2.restock.needs.length === 1 && brief2.restock.needs[0].soldInWindow >= 25,
    JSON.stringify(brief2.restock.needs.map((r) => r.soldInWindow)))
  ok('简报：建议补货量可复算（日均×覆盖天数 − 现有）',
    brief2.restock.needs[0].suggestQty === Math.ceil((25 / brief2.restock.windowDays) * brief2.restock.coverDays),
    'suggest=' + brief2.restock.needs[0].suggestQty)

  // 盘点："还没开始盘" 不等于 "没有差异"（第一版把前者说成了后者）
  const takeId = bdb.prepare("INSERT INTO stock_takes (take_no, status, started_at, operator) VALUES (?,?,?,?)").run('ST-TEST', '进行中', ts, '测试').lastInsertRowid
  bdb.prepare("INSERT INTO stock_take_items (stock_take_id, product_id, system_qty, actual_qty) VALUES (?,?,?,?)").run(Number(takeId), pid, 10, null)
  const brief3 = cmd.buildBriefing(bdb)
  ok('简报：盘点"已盘 0 项"必须说成"还没盘"，不能说成"差异 0 项 ✓"',
    brief3.stock.take.counted === 0 && brief3.stock.take.notCounted === 1 && brief3.stock.take.diffCount === 0)
  bdb.close()
}

// 48. 库位调拨（stock:transfer）—— 它敢碰真实库存，就先把"不破坏口径"的保证锁死
//     背景：优选仓备货过去用「出库」记 → 货从账上消失 + 那 31 笔 out 被当出货（详见 docs/待办-优选仓24个商品）
{
  const sdb = openDatabase(path.join(tmp, 'transfer.db'))
  cmd.createProduct(sdb, { sku_code: 'TR-1', category: '鱼线', brand: '调拨牌', model: 'A', cost_price: 300, suggest_price: 600, status: '在售' })
  const pid = sdb.prepare("SELECT id FROM products WHERE sku_code='TR-1'").get().id
  cmd.createInbound(sdb, { productId: pid, quantity: 20, costPrice: 300, location: 'A墙', operator: '测试' })

  const before = {
    stock: sdb.prepare('SELECT COALESCE(SUM(quantity),0) q, COALESCE(SUM(quantity*cost_price),0) v FROM inventory_batches WHERE product_id=?').get(pid),
    tx: sdb.prepare('SELECT COUNT(*) n FROM transactions').get().n,
    overview: analyticsOverview(sdb),
    trend: analyticsTrend(sdb, 7).reduce((s, r) => s + r.revenue + r.profit, 0),
    audit: sdb.prepare('SELECT COUNT(*) n FROM audit_log').get().n,
  }

  const r1 = cmd.transferStock(sdb, { productId: pid, quantity: 8, fromLocation: 'A墙', toLocation: '优选仓', operator: '测试' })
  ok('调拨：返回调拨数量与目标批次', r1.moved === 8 && r1.toBatches.length === 1 && r1.toBatches[0].quantity === 8)
  ok('调拨：成本随货走（不填 unitCost 时沿用源批次成本）', r1.toBatches[0].costPrice === 300, JSON.stringify(r1.unitCosts))

  const after = {
    stock: sdb.prepare('SELECT COALESCE(SUM(quantity),0) q, COALESCE(SUM(quantity*cost_price),0) v FROM inventory_batches WHERE product_id=?').get(pid),
    tx: sdb.prepare('SELECT COUNT(*) n FROM transactions').get().n,
    overview: analyticsOverview(sdb),
    trend: analyticsTrend(sdb, 7).reduce((s, r) => s + r.revenue + r.profit, 0),
    audit: sdb.prepare('SELECT COUNT(*) n FROM audit_log').get().n,
  }
  ok('调拨：**库存总量不变**', before.stock.q === after.stock.q, before.stock.q + ' → ' + after.stock.q)
  ok('调拨：**库存金额不变**', before.stock.v === after.stock.v, before.stock.v + ' → ' + after.stock.v)
  ok('调拨：**一笔 transactions 都不写**（不然会被算成销售/出货）', before.tx === after.tx, before.tx + ' → ' + after.tx)
  ok('调拨：营业额/毛利/库存金额 概览完全不变', JSON.stringify(before.overview) === JSON.stringify(after.overview))
  ok('调拨：销售趋势（额+毛利）不变', before.trend === after.trend)
  ok('调拨：留了一条审计', after.audit === before.audit + 1)

  const locs = cmd.stockByLocation(sdb, pid)
  const a = locs.find((l) => l.location === 'A墙'), to = locs.find((l) => l.location === '优选仓')
  ok('调拨：库位分布真的变了（A墙 20→12，优选仓 0→8）', a.qty === 12 && to.qty === 8, JSON.stringify(locs))

  // 失败路径：必须报错且**回滚**（数量不能被改坏）
  const beforeFailQty = sdb.prepare('SELECT COALESCE(SUM(quantity),0) q FROM inventory_batches WHERE product_id=?').get(pid).q
  let e1 = null; try { cmd.transferStock(sdb, { productId: pid, quantity: 999, fromLocation: 'A墙', toLocation: '优选仓' }) } catch (e) { e1 = e.message }
  ok('调拨：库存不足时报错（不是静默扣成负数）', /库存不足/.test(e1 ?? ''), String(e1))
  let e2 = null; try { cmd.transferStock(sdb, { productId: pid, quantity: 1, fromLocation: 'A墙', toLocation: 'A墙' }) } catch (e) { e2 = e.message }
  ok('调拨：源=目标时报错', /相同/.test(e2 ?? ''), String(e2))
  ok('调拨：失败后数量没被改坏', sdb.prepare('SELECT COALESCE(SUM(quantity),0) q FROM inventory_batches WHERE product_id=?').get(pid).q === beforeFailQty)

  // 跨库兼容：中心库那份 inventory_batches **没有 updated_at / guid 列** → 命令里绝不许写它们
  const stockSrc = fs.readFileSync(path.resolve('electron/commands/stock.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok('调拨命令不在 inventory_batches 上写 updated_at/guid（否则在中心库直接报错）',
    !/INSERT INTO inventory_batches[\s\S]{0,300}?(updated_at|guid)/.test(stockSrc) && !/UPDATE inventory_batches[\s\S]{0,120}?(updated_at|guid)/.test(stockSrc))
  sdb.close()
}

// 49. 中心库配置的主进程事实源（P0 2026-09-15）—— 防的是"收银机静默退回本地模式"这类最难发现的错
{
  const cdir = path.join(tmp, 'centralcfg')
  const file = path.join(cdir, 'central.json')

  const c0 = initCentralConfig(cdir)
  ok('中心库配置：目录为空时判定"没配"', c0.url === '' && c0.token === '' && isCentralConfigured() === false)

  // 写：带尾部斜杠和空格，必须被归一（否则两台机器写出来的 URL 不一样，比对/排查都会踩坑）
  const w = setCentralConfigLocal({ url: '  https://app.junchengzn.com/  ', token: '  tok-abc  ' })
  ok('中心库配置：URL 去掉尾部斜杠、token 去空格', w.url === 'https://app.junchengzn.com' && w.token === 'tok-abc', JSON.stringify(w))
  ok('中心库配置：文件已落盘', fs.existsSync(file))
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  ok('中心库配置：文件里只有 url/token 两个字段', Object.keys(raw).sort().join() === 'token,url')
  ok('中心库配置：临时文件没留下（原子替换）', !fs.existsSync(file + '.tmp'))
  // 0600：只给本用户读（同目录下的 server-token.txt 也是这个规ge）
  if (process.platform !== 'win32') {
    ok('中心库配置：文件权限 0600', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8))
  } else {
    ok('中心库配置：Windows 上跳过权限位断言（POSIX mode 不适用）', true)
  }

  // 重启后仍在（这就是"文件是事实源"的意义）
  initCentralConfig(cdir)
  ok('中心库配置：重启后仍读得到（不依赖 localStorage）', isCentralConfigured() === true && getCentralConfigLocal().url === 'https://app.junchengzn.com')

  // 半截配置一律当"没配"（与 cloud.js 的 saveLocalConfig 同一铁律）
  setCentralConfigLocal({ url: 'https://only-url.example', token: '' })
  ok('中心库配置：只有 URL 没 token → 当成没配（不留半截）', isCentralConfigured() === false && getCentralConfigLocal().url === '')

  // 断开
  setCentralConfigLocal({ url: '', token: '' })
  ok('中心库配置：清空后判定"没配"', isCentralConfigured() === false)

  // 🔴 负向守卫：这个模块绝不能把 token 打进日志（与 start-central.mjs 那次泄露同一类教训）
  const ccSrc = fs.readFileSync(path.resolve('electron/centralConfig.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok('中心库配置：源码里没有任何把 token 打进 console 的地方',
    !/console\.[a-z]+\([^\n]*token/i.test(ccSrc), '出现了 console 打印 token')
}

// 50. 功能开关（P3 2026-09-15）—— "秒关"这件事，每条边界都要有断言盯着
{
  const fdir = path.join(tmp, 'flags')
  fs.mkdirSync(fdir, { recursive: true })
  const localFile = path.join(fdir, 'flags.json')
  const remoteFile = path.join(fdir, 'flags-remote.json')
  const fakeOk = (body) => async () => ({ ok: true, status: 200, json: async () => body })
  const fakeStatus = (status) => async () => ({ ok: false, status, json: async () => ({}) })
  // 关掉开关时**连数据库都不该碰** —— 用会爆炸的假库当探针，比"看返回值"硬得多
  const trapDb = { prepare() { throw new Error('不该碰数据库') } }

  console.log('\n=== 50. 功能开关（P3）===')

  // ---- 出厂默认 / 坏文件 / 未登记 ----
  flags.initFlags(fdir)
  ok('开关：目录为空时按出厂默认', flags.isEnabled('stockTransfer') === true)
  ok('开关：未登记的名字一律关（fail-closed）', flags.isEnabled('notAFlag') === false && flags.isEnabled('') === false)
  fs.writeFileSync(localFile, '{ 这是坏掉的 JSON', 'utf8')
  ok('开关：本机文件坏掉 → 按出厂默认（**不是**把所有功能关掉）', flags.isEnabled('stockTransfer') === true)
  ok('开关：坏文件也不抛异常', flags.flagStatus().ok === true)

  // ---- B6 执行点：关掉必须真的拦住，而不只是界面上藏起来 ----
  flags.setLocalFlag('stockTransfer', false)
  let tErr = ''
  try { cmd.transferStock(trapDb, { productId: 1, quantity: 1, toLocation: 'X' }) } catch (e) { tErr = e.message }
  ok('开关：关掉「库位调拨」后 transferStock 真的拒绝，且连数据库都没碰',
    /已关闭/.test(tErr), tErr)
  flags.setLocalFlag('stockTransfer', true)
  let tErr2 = ''
  try { cmd.transferStock(trapDb, { productId: 1, quantity: 1, toLocation: 'X' }) } catch (e) { tErr2 = e.message }
  ok('开关：打开后不再是"已关闭"（走到真正的业务校验）', !/已关闭/.test(tErr2) && /不该碰数据库/.test(tErr2), tErr2)

  flags.setLocalFlag('aiBriefing', false)
  let bErr = ''
  try { cmd.buildBriefing(trapDb) } catch (e) { bErr = e.message }
  ok('开关：关掉「AI 简报」后 buildBriefing 真的拒绝', /已关闭/.test(bErr), bErr)
  flags.setLocalFlag('aiBriefing', true)
  let bErr2 = ''
  try { cmd.buildBriefing(trapDb) } catch (e) { bErr2 = e.message }
  ok('开关：打开后走到真正的业务（不再是"已关闭"）', !/已关闭/.test(bErr2), bErr2)

  // ---- B7 秒级生效：改完不用重启（这是"秒关"的本体）----
  flags.setLocalFlag('stockTransfer', false)
  ok('开关：改完立刻生效（同一进程内，不用重启）', flags.isEnabled('stockTransfer') === false)
  fs.writeFileSync(localFile, JSON.stringify({ stockTransfer: true }), 'utf8')
  ok('开关：**手改本机文件**也立刻生效（按 mtime+size 热读，不用重启）', flags.isEnabled('stockTransfer') === true)
  fs.writeFileSync(localFile, JSON.stringify({ stockTransfer: false, stockTrasnfer: false }), 'utf8')
  const stTypo = flags.flagStatus()
  ok('开关：名字打错**不会**生效（所以必须报出来，否则"以为关了其实没关"）',
    stTypo.unknownLocal.includes('stockTrasnfer') && flags.isEnabled('stockTransfer') === false)
  ok('开关：设置未登记的名字被拒（不让脏数据长进文件）', flags.setLocalFlag('nope', true).ok === false)

  // ---- B4 四层优先级：表驱动，9 种组合逐个断言（★ 两条是核心语义）----
  const cases = [
    // [远端, 本机, 期望, 来源]
    [null, null, true, 'default'],
    [null, false, false, 'local'],
    [null, true, true, 'local'],
    [false, null, false, 'remote-off'],
    [false, false, false, 'remote-off'],
    [false, true, false, 'remote-off'], // ★ 远端"关"压过本机"开"
    [true, null, true, 'remote-on'],
    [true, false, false, 'local'], // ★ 本机"关"能否决远端"开"
    [true, true, true, 'local'],
  ]
  for (const [remote, local, want, wantSrc] of cases) {
    await flags.refreshRemoteFlags({ url: 'https://cfg.example/flags.json', fetchImpl: fakeOk(remote === null ? { flags: {} } : { flags: { stockTransfer: remote } }) })
    flags.setLocalFlag('stockTransfer', local)
    const label = `远端${remote === null ? '未下发' : remote ? '开' : '关'}·本机${local === null ? '未设' : local ? '开' : '关'}`
    ok(`开关优先级（${label}）→ ${want ? '开' : '关'}（来源 ${wantSrc}）`,
      flags.isEnabled('stockTransfer') === want && flags.flagSource('stockTransfer') === wantSrc,
      `实际 ${flags.isEnabled('stockTransfer')} / ${flags.flagSource('stockTransfer')}`)
  }

  // ---- B5 缓存与节流：离线也要听服务端的（尤其是"关"）----
  ok('开关：服务端下发会落盘（离线也生效）',
    fs.existsSync(remoteFile) && typeof JSON.parse(fs.readFileSync(remoteFile, 'utf8')).fetchedAt === 'string')
  ok('开关：刚同步过就不再重复去取（默认 6 小时节流）',
    flags.shouldFetchRemote() === false && flags.shouldFetchRemote(0) === true)
  await flags.refreshRemoteFlags({ url: 'https://cfg.example/flags.json', fetchImpl: fakeOk({ flags: { stockTransfer: false } }) })
  flags.setLocalFlag('stockTransfer', null)
  flags.initFlags(fdir) // 模拟重启
  ok('开关：重启后仍记得服务端下发的"关"（离线也能秒关）', flags.isEnabled('stockTransfer') === false)

  // ---- B8 下发失败不能成为新的故障面 ----
  const before = flags.isEnabled('stockTransfer')
  const r404 = await flags.refreshRemoteFlags({ url: 'https://cfg.example/f.json', fetchImpl: fakeStatus(404) })
  ok('开关：下发 404 → 返回原因、现状不变', r404.ok === false && flags.isEnabled('stockTransfer') === before)
  const rBad = await flags.refreshRemoteFlags({ url: 'https://cfg.example/f.json', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('不是 JSON') } }) })
  ok('开关：下发内容不是 JSON → 现状不变', rBad.ok === false && flags.isEnabled('stockTransfer') === before)
  const rThrow = await flags.refreshRemoteFlags({ url: 'https://cfg.example/f.json', fetchImpl: async () => { throw new Error('网络不通') } })
  ok('开关：网络不通 → 现状不变、不抛异常',
    rThrow.ok === false && /网络不通/.test(rThrow.reason) && flags.isEnabled('stockTransfer') === before)
  const rHttp = await flags.refreshRemoteFlags({ url: 'http://evil.example/f.json', fetchImpl: fakeOk({}) })
  ok('开关：非 https 下发地址被拒', rHttp.ok === false && /只允许 https/.test(rHttp.reason), rHttp.reason)

  // ---- B9 读开关本身绝不能崩（最坏情况一律回出厂默认）----
  flags.initFlags(path.join(fdir, 'definitely-missing-dir'))
  ok('开关：dataDir 不存在 → 按出厂默认，不抛', flags.isEnabled('stockTransfer') === true)
  flags.initFlags('')
  ok('开关：未初始化 → 按出厂默认，状态照样可读',
    flags.isEnabled('stockTransfer') === true && flags.flagStatus().ok === true)
  ok('开关：未初始化时 setLocalFlag 明确拒绝（不静默失败）', flags.setLocalFlag('stockTransfer', false).ok === false)

  // ---- B10 可观测：每个开关都要能说清"为什么算开/算关" ----
  flags.initFlags(fdir)
  flags.setLocalFlag('stockTransfer', false)
  const st = flags.flagStatus()
  ok('开关：状态里每个开关都有 有效值 + 来源 + 人话说明',
    st.flags.length === Object.keys(flags.FLAG_DEFS).length &&
    st.flags.every((f) => typeof f.on === 'boolean' && typeof f.source === 'string' && typeof f.desc === 'string' && f.desc.length > 0))
  ok('开关：本机文件原子写、不留 .tmp', !fs.existsSync(localFile + '.tmp'))
  ok('开关：设置后本机文件真的存在', fs.existsSync(localFile))
  flags.setLocalFlag('stockTransfer', null)
  ok('开关：恢复默认后**不留空文件**（"这台机器有没有本机覆盖"要一眼看得出来）', !fs.existsSync(localFile))
  flags.setLocalFlag('stockTransfer', false)
  ok('开关：文件里只会有登记的键',
    Object.keys(JSON.parse(fs.readFileSync(localFile, 'utf8'))).every((k) => k in flags.FLAG_DEFS))
  if (process.platform !== 'win32') {
    ok('开关：本机文件权限 0600', (fs.statSync(localFile).mode & 0o777) === 0o600)
  } else {
    ok('开关：Windows 上跳过权限位断言（POSIX mode 不适用）', true)
  }

  // ---- 登记表 vs 调用点：防止"开关是装饰品"或"名字打错导致功能被意外关掉" ----
  const usedFlags = new Set()
  const walkFlagsUse = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const a = path.join(d, e.name)
      if (e.isDirectory()) { walkFlagsUse(a); continue }
      if (!e.name.endsWith('.js')) continue
      const s = fs.readFileSync(a, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const m of s.matchAll(/isEnabled\(\s*'([A-Za-z0-9_]+)'/g)) usedFlags.add(m[1])
    }
  }
  walkFlagsUse(path.resolve('electron'))
  const declared = Object.keys(flags.FLAG_DEFS)
  ok('开关：登记表里每个开关都真的有调用点（否则它只是装饰品）',
    declared.every((n) => usedFlags.has(n)), declared.filter((n) => !usedFlags.has(n)).join(' '))
  ok('开关：代码里用到的每个名字都在登记表里（否则 isEnabled 恒为 false = 功能被意外关掉）',
    [...usedFlags].every((n) => n in flags.FLAG_DEFS), [...usedFlags].filter((n) => !(n in flags.FLAG_DEFS)).join(' '))

  // ---- 接线：界面能改、中心库服务器也认、通道归本机 ----
  const apiSrcF = fs.readFileSync(path.resolve('src/lib/api.ts'), 'utf8')
  const cardSrc = fs.readFileSync(path.resolve('src/pages/settings/FeatureFlagsCard.tsx'), 'utf8')
  ok('开关：三个通道都归本机（否则中心库模式下会打到服务器 404）',
    ['flags:status', 'flags:set', 'flags:refresh'].every((c) => apiSrcF.includes(`'${c}'`)))
  ok('开关：设置页的卡片能看/能改/能同步，并且显示来源',
    /flags:status/.test(cardSrc) && /flags:set/.test(cardSrc) && /flags:refresh/.test(cardSrc) && /SOURCE_LABEL/.test(cardSrc))
  ok('开关：设置页真的挂了这张卡',
    /<FeatureFlagsCard \/>/.test(fs.readFileSync(path.resolve('src/pages/SettingsPage.tsx'), 'utf8')))
  ok('开关：中心库服务器启动脚本也初始化了开关（手机/桌面打到那边，不认开关等于没关）',
    /initFlags\(dataDir\)/.test(fs.readFileSync(path.resolve('scripts/server/start-central.mjs'), 'utf8')))
  // 2026-09-15 上生产机核对：sync.junchengzn.com 是反代给 inventory-cloud，只有 /updates/* 是静态托管。
  // 写成 /flags/ 会 404，表现是"拉不到下发" —— 静默失效，所以钉一条断言。
  ok('开关：远端下发默认地址落在 /updates/ 下（/flags/ 没有路由会 404）',
    /DEFAULT_REMOTE_URL = 'https:\/\/sync\.junchengzn\.com\/updates\//.test(fs.readFileSync(path.resolve('electron/flags.js'), 'utf8')))
}

// ============ 库：清空商品后不许被"自动播种 + 自动回退"毁掉（2026-09-18 事故回归）============
// 事故链（中心库真机实测，非推测）：
//   命令层清空商品 → products=0 → 下次启动 openDatabase 自动播种 → 演示商品用的是**超市分类**
//   （饮料/零食/食品/日用百货/文具办公/五金工具/生鲜）→ 撞上**渔具产线** products.category 的 CHECK
//   （只允许 20 个渔具分类）→ 播种抛错 → 被 openDatabase 的"迁移失败自动回退"接住 →
//   **把 data.db 整个覆盖成 .pre-migration.bak（几天前的旧备份）** → 清空白做，还静默丢数据。
{
  // ① 已开过张的清空库：重开不许再播种（fi-onboarded 闸）
  const obPath = path.join(tmp, 'clear-onboarded.db')
  const ob1 = openDatabase(obPath)
  ok('清库回归：新库先播了演示数据', ob1.prepare('SELECT COUNT(*) n FROM products').get().n === 12)
  // 分类/单位用**相对断言**：先记下清空前的数量，清空后必须一模一样。
  // （不写死「20 个」—— 新库只自带 1 个分类「其他」，20 个渔具分类是实际业务里建出来的。）
  const catsBefore = ob1.prepare('SELECT COUNT(*) n FROM categories').get().n
  const unitsBefore = ob1.prepare('SELECT COUNT(*) n FROM units').get().n
  const parentsBefore = ob1.prepare("SELECT COUNT(*) n FROM categories WHERE parent IS NOT NULL AND parent <> ''").get().n
  cmd.resetDemoData(ob1)
  ok('清库回归：走命令层清空后商品为 0', ob1.prepare('SELECT COUNT(*) n FROM products').get().n === 0)
  ok('清库回归：清空后流水也清了', ob1.prepare('SELECT COUNT(*) n FROM transactions').get().n === 0)
  ok('清库回归：分类一个没少（清空不动分类）',
    ob1.prepare('SELECT COUNT(*) n FROM categories').get().n === catsBefore && catsBefore > 0)
  ok('清库回归：大分类（parent）一个没少',
    ob1.prepare("SELECT COUNT(*) n FROM categories WHERE parent IS NOT NULL AND parent <> ''").get().n === parentsBefore)
  ok('清库回归：单位一个没少（清空不动单位）',
    ob1.prepare('SELECT COUNT(*) n FROM units').get().n === unitsBefore && unitsBefore > 0)
  ok('清库回归：清空会写下 fi-onboarded=1（"已开张"的凭据）',
    ob1.prepare("SELECT value FROM settings WHERE key = 'fi-onboarded'").get()?.value === '1')
  finalCheckpoint(ob1)
  ob1.close()
  const ob2 = openDatabase(obPath) // ← 事故的触发点：清空之后重开
  ok('清库回归：清空并开过张后，重开不再自动播种（商品仍为 0）',
    ob2.prepare('SELECT COUNT(*) n FROM products').get().n === 0)
  ok('清库回归：重开后分类仍是清空前的数量（没被清掉也没被重播）',
    ob2.prepare('SELECT COUNT(*) n FROM categories').get().n === catsBefore)
  finalCheckpoint(ob2)
  ob2.close()

  // ② 播种真失败时，也绝不许把库拖进"回退旧备份"那条销毁路径
  const bfPath = path.join(tmp, 'seed-fails.db')
  const bf1 = openDatabase(bfPath)
  // 用命令层清空（它按外键依赖顺序删，手写 DELETE 会撞 FOREIGN KEY）
  cmd.resetDemoData(bf1)
  // 但把"已开张"标记抹掉 → 模拟一台"商品为空且没开过张"的库，下次打开就会尝试播种
  bf1.exec("DELETE FROM settings WHERE key = 'fi-onboarded'")
  // 用触发器让播种的第一次产品 insert 必然失败。选触发器而不是改 CHECK：
  // 它不会被 SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS 冲掉，复现稳定。
  bf1.exec("CREATE TRIGGER test_block_seed BEFORE INSERT ON products BEGIN SELECT RAISE(ABORT, '测试：拦截播种'); END")
  finalCheckpoint(bf1)
  bf1.close()
  const bf2 = openDatabase(bfPath) // 闸②：这一行必须不抛错（抛了就整条套件崩，本断言就红了）
  ok('清库回归：播种失败时 openDatabase 照样能开（不阻断启动）', !!bf2)
  ok('清库回归：播种失败时库保持空（没被旧备份顶掉）',
    bf2.prepare('SELECT COUNT(*) n FROM products').get().n === 0)
  ok('清库回归：播种失败时前面的供应商插入也被回滚干净',
    bf2.prepare('SELECT COUNT(*) n FROM suppliers').get().n === 0)
  finalCheckpoint(bf2)
  bf2.close()

  // ③ 源码形状：两道闸都不许被后来人顺手删掉
  const dbSrc2 = fs.readFileSync(path.resolve('electron/db.js'), 'utf8')
  ok('清库回归：播种前先查"是否已开张"',
    /if \(row\.n === 0 && !isOnboarded\(db\)\)/.test(dbSrc2))
  ok('清库回归：播种被 try/catch 包住（失败只告警，不触发回退）',
    /try \{\s*\n\s*seedDatabase\(db\)\s*\n\s*\} catch/.test(dbSrc2))
}

// ============ 界面：「刷新界面」按钮（2026-09-20 owner 要求）============
// owner 原话：「加一个刷新界面的按钮在右上角，不然没错的数据同步都得重启一遍」。
// 要害不是"有没有这个按钮"，而是**它只能是软刷新**：
//   开单页的购物车是页面局部 state（OutboundPage 的 useState<CartItem[]>），
//   谁哪天把刷新改成 location.reload() 或重挂载页面，收银机误触一下就把没结的单丢了 ——
//   那不是刷新，是事故。所以那条负向守卫比正向的还重要。
{
  const topbar = fs.readFileSync(path.resolve('src/components/layout/TopBar.tsx'), 'utf8')
  ok('刷新按钮：顶栏有它（右上角，带 aria-label）', /aria-label="刷新界面"/.test(topbar))
  ok('刷新按钮：真的重拉数据（调 loadAll）', /await loadAll\(\)/.test(topbar))
  ok('刷新按钮：顺带重拉客户列表（loadAll 不含客户）', /loadCustomers\(\)/.test(topbar))
  // 判"有没有整页 reload"之前**必须先去注释**：注释里写着
  // 「绝不调 location.reload()」是文档，不是调用；不去注释就会把文档判成事故。
  const topbarCode = topbar
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^\s*\/\/.*$/gm, '') // 整行注释（只去整行的，避免误伤字符串里的 https://）
  ok('刷新按钮：是软刷新，不整页 reload（否则会丢正在开的单）',
    !/location\.reload|location\.href\s*=/.test(topbarCode))
  ok('刷新按钮：防重复点击（refreshing 期间不重入）', /if \(refreshing\) return/.test(topbar))
  ok('刷新按钮：有进行中/已完成反馈（转圈 + 打勾）',
    /animate-spin/.test(topbar) && /justRefreshed/.test(topbar))
}

// ============ 界面：库存页「先品牌、再规格」两级视图（2026-09-20 owner 要求）============
// owner 原话：「在库存里不能一进去就看到某个规格，而是子品牌，我想看有哪些规格的时候，
//   再点击进去看规格，规格又分别有哪些数量…一下子把（一个品牌的）所有规格全部摆在明面上，
//   太多了，渔具这行业的规格又多，而且鱼竿品牌又多」。
// 量过（清空前的 324 个商品）：一行就是一个独立规格（商品数 == 不同 SKU 数 == 324），
//   按品牌分是 58 组（最大「没填品牌」125 个规格）—— 平铺 324 行才是"太乱"的根源。
{
  const inv = fs.readFileSync(path.resolve('src/pages/InventoryPage.tsx'), 'utf8')
  const grp = fs.readFileSync(path.resolve('src/pages/inventory/BrandGroupList.tsx'), 'utf8')
  ok('库存两级：有第一层的品牌分组组件（BrandGroupList）', /export function BrandGroupList/.test(grp))
  ok('库存两级：第一层说的是"多少个规格 + 共多少件"（老板要的就是这两个数）',
    /个规格/.test(grp) && /共 \{g\.stock\.toLocaleString\(\)\} 件/.test(grp))
  // 这条是要害：分组若从 products（全量）算，搜索/分类/只看缺货 在这些分组上就会失效
  ok('库存两级：分组从**筛选结果**算（搜索/分类/只看缺货 在两级里都照旧生效）',
    /const brandGroups = useMemo<BrandGroup\[\]>\(\(\) => \{[\s\S]*?for \(const p of filtered\)/.test(inv))
  ok('库存两级：点进品牌才看规格明细（openBrand 控制 + 表格吃 visibleProducts）',
    /const \[openBrand, setOpenBrand\] = useState<string \| null>\(null\)/.test(inv) &&
      /products=\{visibleProducts\}/.test(inv))
  ok('库存两级：「没填品牌」不被这个新视图藏起来（有哨兵键 + 有中文名）',
    /const NO_BRAND = '__no_brand__'/.test(inv) && /没填品牌/.test(inv))
  ok('库存两级：导出/开单码跟着"看得见的那批"，不是全量（否则进了老鬼却导出全店）',
    /const rows = visibleProducts\.map/.test(inv) && /products=\{visibleProducts\}\s*\n\s*serverUrl/.test(inv))
  // 空库（0 商品）或筛空时，品牌分组是空数组、BrandGroupList 返回 null ——
  // 若还停第一层分支就是一片白屏。所以必须回落到表格，让它自带空态去说话。
  ok('库存两级：没商品/筛空时不落成白屏（分组空就回落表格的空态）',
    /openBrand === null && brandGroups\.length > 0/.test(inv))
}

// ============ 数据分析：畅销 Top N 必须能真跑起来（2026-09-21 修 p.name 400）============
// 背景：线上 GET /api/analytics/top 实测 400「no such column: p.name」。
//   analyticsTop 的 SQL 里引用了 products 表根本没有的列 p.name；同一句里还顺手 select 了
//   p.brand/p.model/p.sku_code，但取值全走另一条 lookup —— 那 4 个列一点用没有，只负责把整条
//   SQL 弄挂。坏这么久没人发现，是因为这里只断言过 overview/trend，Top 这条线从没跑过。
// 口径（与 querySummary / inv-analytics 一致）：营业额 = out − return（换货退旧不算），
//   商品名 = 品牌+型号 → 回退 SKU（helpers.productLabel）。
{
  const adb = openDatabase(path.join(tmp, 'analytics-top.db'))
  // 新库自带 12 个演示商品 + 它们的流水；不清掉的话榜单里会混进种子数据，断言就不干净了
  cmd.resetDemoData(adb)
  cmd.createProduct(adb, { sku_code: 'AT-1', category: '鱼线', brand: '光威', model: '老竿 3.6m', cost_price: 4200, suggest_price: 9000, status: '在售' })
  cmd.createProduct(adb, { sku_code: 'AT-2', category: '鱼线', brand: '达亿瓦', model: '老路亚 2.1m', cost_price: 15500, suggest_price: 20000, status: '在售' })
  cmd.createProduct(adb, { sku_code: 'AT-3', category: '鱼线', cost_price: 100, suggest_price: 5000, status: '在售' })
  const atP = (sku) => adb.prepare('SELECT id FROM products WHERE sku_code=?').get(sku).id
  const p1 = atP('AT-1'), p2 = atP('AT-2'), p3 = atP('AT-3')
  const insAt = adb.prepare('INSERT INTO transactions (product_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, channel, store_code) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const atTs = new Date().toISOString()
  insAt.run(p1, 'out', 3, 4200, 9000, atTs, '测试', '', 'pos', '') // AT-1：27000 / 毛利 14400 / 3 件
  insAt.run(p1, 'return', 1, 4200, 9000, atTs, '测试', '', 'pos', '') // 退货冲减 → 18000 / 9600 / 2 件
  insAt.run(p2, 'out', 1, 15500, 20000, atTs, '测试', '', 'pos', '') // AT-2：20000（第一名）
  insAt.run(p2, 'return', 1, 15500, 20000, atTs, '测试', '换货退旧', 'pos', '') // 换货退旧：不计
  insAt.run(p3, 'out', 2, 100, 5000, atTs, '测试', '', 'pos', '') // AT-3：10000

  const top = analyticsTop(adb, 10)
  ok('畅销Top：**能真跑起来**（SQL 引用不存在的列时，线上这条接口直接 400）',
    Array.isArray(top) && top.length === 3, '返回 ' + top.length + ' 条')
  ok('畅销Top：名字是「品牌+型号」（不是 products.name —— 那列根本不存在）',
    top[0].name === '达亿瓦 老路亚 2.1m', top.map((r) => r.name).join(' / '))
  ok('畅销Top：按营业额降序（20000 > 18000 > 10000）',
    top.map((r) => r.revenue).join(',') === '20000,18000,10000', top.map((r) => r.revenue).join(','))
  ok('畅销Top：退货冲减、换货退旧不计（AT-1 27000−9000=18000；AT-2 不被冲成 0）',
    top[0].revenue === 20000 && top[1].revenue === 18000)
  ok('畅销Top：件数/毛利跟着口径走（AT-1 净 2 件、毛利 9600）',
    top[1].qty === 2 && top[1].profit === 9600, 'qty=' + top[1].qty + ' profit=' + top[1].profit)
  ok('畅销Top：品牌型号都没填 → 名字回退 SKU', top[2].name === 'AT-3', top[2].name)
  const top2 = analyticsTop(adb, 2)
  ok('畅销Top：n 生效（要 2 条就只给 2 条，且是最高的两条）',
    top2.length === 2 && top2[0].name === '达亿瓦 老路亚 2.1m' && top2[1].name === '光威 老竿 3.6m')
  ok('畅销Top：n 传坏值不炸（-5 收成 1 条、非数字回退 10）',
    analyticsTop(adb, -5).length === 1 && analyticsTop(adb, 'abc').length === 3)
  adb.close()
}

// ============ 通道闸门：渲染层用到的通道必须全部在壳放行名单里（2026-09-21 补）============
// 起因：src/pages/AiHubPage.tsx 与 src/pages/settings/AiModelCard.tsx 调 `ai:setEndpoint` /
//   `ai:syncCentral`，而 electron/preload.cjs 的白名单里**从来没有**这两个（main.js:427-428 有实现）。
//   后果：build-web-bundle.mjs 第 ④ 步直接红 → 前端热更发不出去；真机壳也会拒绝这类热更包
//   （运行期判据用的是**壳自己**那份 preload：main.js:768 传 `__dirname/preload.cjs`）。
//   已从已装 1.1.13 的 app.asar 里取证：壳内 preload 这两条 = false、壳内 main.js = true。
// 这条断言等于把"发版时才红"提前到"提交时就红"，判据与发布侧/客户端完全同一套。
{
  const used = channelsUsedInSrc(path.resolve('.'))
  const supported = readSupportedChannels(
    path.resolve('electron/preload.cjs'),
    path.resolve('electron/server.js'),
  )
  const missing = [...used].filter((c) => !supported.has(c)).sort()
  if (missing.length) console.error('  ✗ 壳没放行这些通道：' + missing.join(' '))
  ok('通道闸门：渲染层用到的通道**全部**在壳放行名单里（少一个，热更包就会被真机拒收）',
    missing.length === 0)
  // 防"扫成 0 个通道"的假绿：src 里现在的量级是 140+，若哪天变成个位数说明扫描规则被改坏了
  ok('通道闸门：确实扫到了通道（防止扫描失效导致的假绿）', used.size > 100)

  // 反例自检：故意抽掉一个已知通道，判据必须报出来 —— 否则这条闸门可能是"永远绿"的假闸门
  const fakeSupported = new Set(supported)
  fakeSupported.delete('ai:setEndpoint')
  const fakeMissing = [...used].filter((c) => !fakeSupported.has(c))
  ok('通道闸门：反例自检（抽掉一个通道必须报出来，证明它真的在判）',
    fakeMissing.includes('ai:setEndpoint') && fakeMissing.length === 1)
}

// ============ 盘点状态：手机端不许再把 status 写死 + 拍照要能顺手记数（2026-09-22）============
// 起因（老板原话）：「有图片了，但状态老是显示待盘点，已经有图片证明已经盘点过了」。
//   查真库（178 商品）：42 个「待盘点」**全部一条库存批次都没有**（= 建档时没录数量），其中 5 个有照片。
//   而 2026-09-22 定的规则是：**只要有数量≠0 的批次就算「已盘点」** —— 判据是数量，不是照片。
//   另有 3 处手机端代码把 status 写死成 '待盘点'，会把新规则盖掉；只因后面紧跟 inbound:create
//   又翻回「已盘点」才没暴露。这里全部钉住，并把"拍照 → 问数量 → 记入库"这条路也钉住。
{
  const mp = (p) => fs.readFileSync(path.resolve(p), 'utf8')
  const stockJs = mp('electron/mobile/pages/stock.js')
  const inboundJs = mp('electron/mobile/pages/inbound.js')
  const posJs = mp('electron/mobile/pages/pos.js')
  const productsJs = mp('electron/commands/products.js')

  ok('盘点：手机端不再把 status 写死成「待盘点」（写了就会盖掉"有数量=已盘点"的规则）',
    ![stockJs, inboundJs, posJs].some((s) => /status:\s*'待盘点'/.test(s)))

  // 规则本身还在（防有人把判据改回去）
  ok('盘点：新建商品「填了数量就算已盘点」的规则还在',
    /initialQty > 0 \? '已盘点' : '待盘点'/.test(productsJs))
  ok('盘点：编辑商品不许把有货的退回「待盘点」（statusOfUpdate 还在）',
    /function statusOfUpdate/.test(productsJs) && /return r \? '已盘点' : '待盘点'/.test(productsJs))

  // 拍照即盘点：取 pickProductPhoto 整个函数体（从声明行到第一个两空格缩进的右花括号）
  const lines = stockJs.split('\n')
  const s0 = lines.findIndex((l) => l.includes('async function pickProductPhoto'))
  const s1 = lines.findIndex((l, i) => i > s0 && l === '  }')
  const pickFn = lines.slice(s0, s1 + 1).join('\n')
  ok('盘点：拍照流程确实取到了（防止断言取空导致假绿）', s0 >= 0 && s1 > s0 && pickFn.length > 500)
  ok('盘点：拍照流程会问数量并记一笔入库（批次+库存+状态一次到位）',
    /inbound:create/.test(pickFn) && /prompt\(/.test(pickFn))
  ok('盘点：留空/取消只换图，不动库存（qty 为 0 不入库）',
    /qtyStr === null \? 0/.test(pickFn) && /if \(qty > 0\)/.test(pickFn))
  ok('盘点：先存图片再入库（入库失败也不丢照片）',
    pickFn.indexOf('saveProductPhoto') >= 0 && pickFn.indexOf('saveProductPhoto') < pickFn.indexOf('inbound:create'))
  ok('盘点：入库失败只提示、不抛（照片已存，人可以再补一次）',
    /图片已存，但入库没成功/.test(pickFn))
}

// ============ 录入即规范：品牌可选可输 + 批量建一族规格（2026-09-22，B 步）============
// 起因：老板「一个品牌的产品，规格很多，但却要每一个都录入…规格命名格式不同一，名字不统一」。
//   实测 223 个商品里品牌为空 127 个（57%）。一个直接成因：新建商品的品牌是**写死的预设下拉**，
//   里面没有「狼王」这种店里真在卖的大牌 —— 店员只能点"+ 自定义品牌"手打，或者干脆不填。
{
  const rd = (p) => fs.readFileSync(path.resolve(p), 'utf8')
  const brandField = rd('src/pages/inbound/BrandField.tsx')
  const newDlg = rd('src/pages/inbound/NewProductDialog.tsx')
  const batchDlg = rd('src/pages/inbound/BatchSpecDialog.tsx')
  const inboundPage = rd('src/pages/InboundPage.tsx')

  ok('录入规范：品牌输入以「店里用过的品牌」为主（从 products 累计，用得多排前面）',
    /useAppStore\(\(s\) => s\.products\)/.test(brandField) && /used\.set\(b/.test(brandField))
  ok('录入规范：品牌允许自由输入（datalist，不是只读下拉）',
    /<datalist/.test(brandField) && /list=\{listId\}/.test(brandField))
  ok('录入规范：新建商品不再用写死的预设品牌表（狼王这类牌子选不到，是品牌为空的成因之一）',
    !/BRAND_PRESETS/.test(newDlg) && /BrandField/.test(newDlg))

  ok('批量建族：对话框存在且能从入库页打开',
    /export function BatchSpecDialog/.test(batchDlg) && /BatchSpecDialog/.test(inboundPage))
  ok('批量建族：只走已有通道（store 的 addProduct/addInbound），**不新增 IPC** —— 新增通道旧壳不认',
    /addProduct\(/.test(batchDlg) && /addInbound\(/.test(batchDlg) && !/invoke\(/.test(batchDlg))
  ok('批量建族：建之前先查重（同品牌+同品类+同规格已存在就跳过），堵住"同一条规格建两遍"',
    /existing\.has\(k\)/.test(batchDlg) && /将跳过/.test(batchDlg))
  ok('批量建族：显示名统一由 productName() 产出，不自己拼字符串',
    /productName\(\{/.test(batchDlg))
  ok('批量建族：带数量的行顺手入库（库存与「已盘点」一起到位）',
    /qty > 0/.test(batchDlg) && /addInbound\(/.test(batchDlg))
  ok('批量建族：建档先挂「待盘点」，由入库去翻状态（不从名字/照片推断）',
    /status: '待盘点'/.test(batchDlg))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n全部 ${passed} 项断言通过`)
