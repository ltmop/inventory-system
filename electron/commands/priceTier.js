// 多级定价（v2.0）
// tier 取值与 schema CHECK 一致：retail/regular/VIP/wholesale/promo；价格正整数分；
// 同商品同 tier 覆盖更新（UPSERT）。标准零售价仍走 products.suggest_price，price_tiers 只存额外档次。
import {
  PRICE_TIERS,
  assertPositiveInt,
  inTransaction,
  logAudit,
  productLabel,
} from './helpers.js'

export function setPriceTier(db, { productId, tier, price, operator }) {
  if (!PRICE_TIERS.includes(tier)) throw new Error(`价格档次必须是：${PRICE_TIERS.join(' / ')}，收到：${tier}`)
  assertPositiveInt(price, '档次价格')
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
  if (!prod) throw new Error('商品不存在')
  return inTransaction(db, () => {
    db.prepare(
      `INSERT INTO price_tiers (product_id, tier, price) VALUES (?, ?, ?)
       ON CONFLICT(product_id, tier) DO UPDATE SET price = excluded.price`,
    ).run(productId, tier, price)
    logAudit(db, '改价', productLabel(prod), { tier, price }, operator)
    return db.prepare('SELECT * FROM price_tiers WHERE product_id = ? AND tier = ?').get(productId, tier)
  })
}

export function deletePriceTier(db, { productId, tier }) {
  if (!PRICE_TIERS.includes(tier)) throw new Error(`价格档次必须是：${PRICE_TIERS.join(' / ')}，收到：${tier}`)
  const info = db.prepare('DELETE FROM price_tiers WHERE product_id = ? AND tier = ?').run(productId, tier)
  return { ok: info.changes > 0 }
}

export function getPriceTiers(db, { productId }) {
  return db.prepare('SELECT * FROM price_tiers WHERE product_id = ? ORDER BY id').all(productId)
}
