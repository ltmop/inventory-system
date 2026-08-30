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

  // TTS 合成 → KWS 联动：VITS 输出有随机性，合成语音的检出率非 100%，允许最多 3 次尝试
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
  for (let i = 0; i < 5 && !synthDetected; i++) {
    const w = tts.synthesize({ text: '小杜小杜' })
    if (w.ok) synthDetected = feedWav16k(ttsWavToPcm16(w))
  }
  ok('TTS 合成语音能被 KWS 检出（5 次内）', synthDetected === '小杜小杜')

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

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n全部 ${passed} 项断言通过`)
