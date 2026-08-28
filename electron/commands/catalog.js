// 全量数据查询（启动/数据加载用）

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
  }
}
