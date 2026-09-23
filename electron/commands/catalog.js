// 全量数据查询（启动/数据加载用）
import { parseOpening, ACCOUNT_OPENING_KEY } from '../lib/moneyAccounts.js'

/** 一次性加载桌面首屏需要的全量基础数据（商品 / 分类 / 单位 / 价格档等），只读。 */
export function loadAll(db) {
  const q = (sql) => db.prepare(sql).all()
  // 通用版：单位小数标记（units.allow_decimal）映射到商品行，前端据此判断数量步进
  const decimalUnits = new Set(
    db.prepare('SELECT name FROM units WHERE allow_decimal = 1').all().map((r) => r.name),
  )
  const products = q('SELECT * FROM products ORDER BY id').map((p) => ({
    ...p,
    unit_decimal: decimalUnits.has(p.unit || '件') ? 1 : 0,
  }))
  return {
    products,
    batches: q('SELECT * FROM inventory_batches ORDER BY id'),
    transactions: q('SELECT * FROM transactions ORDER BY timestamp DESC, id DESC'),
    suppliers: q('SELECT * FROM suppliers ORDER BY id'),
    stockTakes: q('SELECT * FROM stock_takes ORDER BY id DESC'),
    stockTakeItems: q('SELECT * FROM stock_take_items ORDER BY id'),
    priceTiers: q('SELECT * FROM price_tiers ORDER BY product_id, id'),
    expenses: q('SELECT * FROM expenses ORDER BY expense_date DESC, id DESC'),
    kits: q('SELECT * FROM kits ORDER BY id DESC'),
    kitItems: q('SELECT * FROM kit_items ORDER BY id'),
    // 通用版：分类/单位列表（首页/设置动态读取）
    categories: q('SELECT * FROM categories ORDER BY sort_order, id'),
    units: q('SELECT * FROM units ORDER BY sort_order, id'),
    // 资金账户期初（2026-09-22）：存在 settings 表的那段 JSON，随首屏一起下发 ——
    // 桌面端因此**不必为资金账户新增 IPC 通道**（新增通道旧壳不认），中心库模式也自动取中心库那份。
    accountOpening: parseOpening(readSetting(db, ACCOUNT_OPENING_KEY)),
  }
}

/** 读 settings 表一个键；表/行不存在一律当没有（老库也不能因此加载失败） */
function readSetting(db, key) {
  try {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null
  } catch {
    return null
  }
}
