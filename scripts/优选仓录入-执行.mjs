// 优选仓 155 件录入（2026-09，已对真实营业库执行）：
// 建档 24 新建 + 7 复用东哥线组现有商品（31 规格），财务后续补成本/售价；
// 出库口径：货已物理发仓、未在店里库存过 → 先入库建「优选仓」批次（成本 0 待财务补），
// 再全量出库（FIFO 扣刚建批次）→ 库存归零、流水留痕「进→发仓」，无负批次（真实库禁止负库存）。
// 用法：node scripts/优选仓录入-执行.mjs [--db=绝对路径]（预检传临时库，正式默认真实库）
import { openDatabase } from '../electron/db.js'
import * as cmd from '../electron/commands.js'
import path from 'node:path'

const argDb = process.argv.find((a) => a.startsWith('--db='))
const dbPath = argDb ? argDb.slice(5) : path.join(process.env.APPDATA, 'fishing-inventory', 'data.db')
console.log('写入数据库:', dbPath)
const db = openDatabase(dbPath)
const OP = '优选仓发货-2026-09'

const results = []
function log(msg) { results.push(msg); console.log(msg) }

// 东哥复用映射（现有 id → model）
const donggeMap = {
  '3.6m-2.0#': 281, '3.6m-2.5#': 282, '3.6m-3.0#': 283,
  '3.9m-2.0#': 285, '3.9m-2.5#': 286,
  '4.5m-2.0#': 290, '4.5m-2.5#': 291,
}
// 清单（组 → 规格:件数）
const LIST = [
  { group: '丸世鱼钩', cat: '鱼钩', specs: { '10#': 10, '12#': 10, '13#': 10, '14#': 10 } },
  { group: '金袖子线双钩', cat: '鱼钩', specs: { '#6': 5, '#7': 5, '#8': 5 } },
  { group: '修罗线', cat: '鱼线', specs: { '3.0#': 3, '4.0#': 3, '5.0#': 3 } },
  { group: '台钓主线组', cat: '鱼线', specs: { '4.5m-2#': 5, '4.5m-2.5#': 5, '4.5m-5#': 5, '5.4m-2.5#': 5, '5.4m-3#': 5, '5.4m-4#': 5, '5.4m-5#': 5 } },
  { group: '雄霸线', cat: '鱼线', specs: { '2.0#': 3, '3.0#': 3, '4.0#': 3, '5.0#': 3, '6.0#': 3, '7.0#': 3, '8.0#': 3 } },
  { group: '东哥线组', cat: '鱼线', specs: { '3.6m-2.0#': 5, '3.6m-2.5#': 5, '3.6m-3.0#': 5, '3.9m-2.0#': 5, '3.9m-2.5#': 5, '4.5m-2.0#': 5, '4.5m-2.5#': 5 } },
]
// SKU 前缀
const skuPref = { '丸世鱼钩': 'A-鱼钩-丸世', '金袖子线双钩': 'A-鱼钩-金袖双钩', '修罗线': 'B-鱼线-修罗', '台钓主线组': 'B-鱼线-台钓主线', '雄霸线': 'B-鱼线-雄霸', '东哥线组': 'B-鱼线-东哥' }
const brandOf = { '丸世鱼钩': '丸世', '金袖子线双钩': '金袖', '修罗线': '修罗', '台钓主线组': '台钓', '雄霸线': '雄霸', '东哥线组': '东哥渔具（主线组）' }

const items = [] // {pid, spec, qty, sku, group}
let created = 0, reused = 0

// ========== 建档 ==========
for (const { group, cat, specs } of LIST) {
  for (const [spec, qty] of Object.entries(specs)) {
    let pid
    if (group === '东哥线组' && donggeMap[spec]) {
      pid = donggeMap[spec]
      reused++
      log('复用: ' + group + ' ' + spec + ' → id ' + pid + ' (qty ' + qty + ')')
    } else {
      // 规格转 model（#在尾 → 号；#在头 → 号数放尾），SKU 用紧凑唯一码
      const model = spec.startsWith('#') ? spec.slice(1) + '号' : spec.replace('#', '号')
      const skuCode = skuPref[group] + '-' + spec.replace(/[.#]/g, '').replace(/-/g, '')
      const p = cmd.createProduct(db, {
        sku_code: skuCode, category: cat, brand: brandOf[group], model,
        cost_price: 0, suggest_price: null, // 成本/售价待财务补
        status: '待盘点', location: '优选仓',
      })
      pid = p.id
      created++
      log('新建: ' + group + ' ' + spec + ' → id ' + pid + ' sku=' + p.sku_code)
    }
    items.push({ pid, spec, qty })
  }
}
log('建档完成: 新建 ' + created + ' / 复用 ' + reused + ' / 共 ' + items.length + ' 规格')

// ========== 入→出（发优选仓，库存净零，流水完整） ==========
let ioOk = 0, ioFail = 0
for (const { pid, spec, qty } of items) {
  try {
    cmd.createInbound(db, { productId: pid, quantity: qty, costPrice: 0, location: '优选仓', operator: OP })
    const r = cmd.confirmOutbound(db, { productId: pid, quantity: qty, operator: OP })
    if (r && r.ok) ioOk++
    else { ioFail++; log('出库失败: id ' + pid + ' ' + spec + ' → ' + JSON.stringify(r)) }
  } catch (e) {
    ioFail++
    log('入出异常: id ' + pid + ' ' + spec + ' → ' + e.message)
  }
}
log('入→出完成: 成功 ' + ioOk + ' / 失败 ' + ioFail + '（共 ' + items.length + ' 规格）')
db.close()
