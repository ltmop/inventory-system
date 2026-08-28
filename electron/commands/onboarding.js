// 新手引导
import { inTransaction } from './helpers.js'

/** 新手引导：清空演示数据正式开张。
 *  铁律：清空前强制跑一次自动备份（数据一旦删除不可恢复）。
 *  清空范围：流水、批次、商品、供应商、盘点单和明细（保留 settings 表） */
export function resetDemoData(db) {
  return inTransaction(db, () => {
    // 删除顺序按外键依赖：先删子表再删主表
    db.exec('DELETE FROM stock_take_items')
    db.exec('DELETE FROM stock_takes')
    db.exec('DELETE FROM transactions')
    db.exec('DELETE FROM inventory_batches')
    db.exec('DELETE FROM expenses')
    db.exec('DELETE FROM payments')
    db.exec('DELETE FROM purchase_order_items')
    db.exec('DELETE FROM purchase_orders')
    db.exec('DELETE FROM price_tiers')
    db.exec('DELETE FROM products')
    db.exec('DELETE FROM suppliers')
    db.exec('DELETE FROM customers')
    // 标记新手引导已完成（下次启动不再弹出）
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('fi-onboarded', '1')
    return { ok: true, message: '演示数据已清空，可以开始录入真实库存了' }
  })
}

/** 完成新手引导（不删数据，只标记已完成） */
export function finishOnboarding(db) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('fi-onboarded', '1')
  return { ok: true }
}

/** 检查新手引导是否已完成 */
export function onboardingStatus(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'fi-onboarded'").get()
    return { completed: row?.value === '1' }
  } catch {
    return { completed: false }
  }
}
