// 全量数据查询（启动/数据加载用）

export function loadAll(db) {
  const q = (sql) => db.prepare(sql).all()
  return {
    products: q('SELECT * FROM products ORDER BY id'),
    batches: q('SELECT * FROM inventory_batches ORDER BY id'),
    transactions: q('SELECT * FROM transactions ORDER BY timestamp DESC, id DESC'),
    suppliers: q('SELECT * FROM suppliers ORDER BY id'),
    stockTakes: q('SELECT * FROM stock_takes ORDER BY id DESC'),
    stockTakeItems: q('SELECT * FROM stock_take_items ORDER BY id'),
    priceTiers: q('SELECT * FROM price_tiers ORDER BY product_id, id'),
    expenses: q('SELECT * FROM expenses ORDER BY expense_date DESC, id DESC'),
    kits: q('SELECT * FROM kits ORDER BY id DESC'),
    kitItems: q('SELECT * FROM kit_items ORDER BY id'),
  }
}
