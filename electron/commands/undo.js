// 撤回（undo）：把「会毁数据的写操作」在动手前留一份可逆快照，用户点一下就能还原。
//
// 为什么这么做：删商品 / 报损 / 入库这三类，一旦点错，库存和流水就被改了，而现有系统只有"整库备份恢复"这一条重手路径。
//   出库走「退货」（会计口径正确，不在这里重复造）；
//   盘点走「重新盘点」（本来就有差异记录）。
//
// 设计原则
//   · 快照只放"怎么还原"的必要信息（被删的那一行 / 本次动的批次与流水 id），不放整库，也不存图片；
//   · 撤回本身也是写操作：同一事务内完成，失败整批回滚；撤过的记录打 undone_at，不能撤两次；
//   · 留不下快照**绝不能挡住业务**（pushUndo 全 catch）——宁可少一次可撤回，也不能让收银员开不了单。
import { inTransaction, now, logAudit } from './helpers.js'
import { assertOwnerAction } from './users.js'

export function ensureUndoTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS undo_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    channel TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT,
    undo_json TEXT NOT NULL,
    operator TEXT,
    undone_at TEXT
  )`)
}

/** 记一条可撤回操作（写不进去就静默跳过，绝不阻断业务） */
export function pushUndo(db, { channel, label, detail, undo, operator }) {
  try {
    ensureUndoTable(db)
    db.prepare('INSERT INTO undo_log (at, channel, label, detail, undo_json, operator) VALUES (?,?,?,?,?,?)')
      .run(now(), String(channel), String(label), detail ? String(detail) : null, JSON.stringify(undo), operator ? String(operator) : null)
    // 顺手清掉 30 天前且已撤回的，别让它无限长
    try {
      db.prepare('DELETE FROM undo_log WHERE undone_at IS NOT NULL AND at < ?')
        .run(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
    } catch { /* 清理失败不重要 */ }
  } catch { /* 绝不阻断业务 */ }
}

/** 最近可撤回的操作（默认 20 条；含已撤回的，界面自己置灰） */
export function listUndo(db, { limit = 20 } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
  try {
    ensureUndoTable(db)
    return db.prepare('SELECT id, at, channel, label, detail, operator, undone_at FROM undo_log ORDER BY id DESC LIMIT ?').all(n)
  } catch { return [] }
}

/** 撤回一条：按快照恢复（同一事务；撤不了就抛错，绝不半截） */
export function applyUndo(db, id, operator = null) {
  assertOwnerAction(db, '撤回操作')
  const row = db.prepare('SELECT * FROM undo_log WHERE id = ?').get(id)
  if (!row) return { ok: false, reason: '这条记录不存在' }
  if (row.undone_at) return { ok: false, reason: '这条已经撤回过了' }
  let snap
  try { snap = JSON.parse(row.undo_json) } catch { return { ok: false, reason: '快照坏了，撤不了（可用整库备份恢复）' } }

  return inTransaction(db, () => {
    if (snap.kind === 'product') {
      // 删商品：把那一行原样插回去（id 也保留，流水/条码引用不断链）
      const r = snap.row
      if (!r || !r.id) throw new Error('快照缺少商品数据')
      const exists = db.prepare('SELECT 1 FROM products WHERE id = ?').get(r.id)
      if (exists) throw new Error('这个商品已经存在了（可能已手动恢复）')
      const cols = Object.keys(r)
      db.prepare('INSERT INTO products (' + cols.map((c) => '"' + c + '"').join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')')
        .run(...cols.map((c) => r[c]))
      logAudit(db, '撤回', '恢复商品 ' + (r.sku_code || ('#' + r.id)), { undoId: id }, operator)
    } else if (snap.kind === 'waste') {
      // 报损：把扣掉的量加回原批次 + 删掉这次留下的损耗记录与流水
      for (const e of snap.entries || []) {
        db.prepare('UPDATE inventory_batches SET quantity = quantity + ? WHERE id = ?').run(e.quantity, e.batchId)
      }
      for (const lid of snap.logIds || []) db.prepare('DELETE FROM waste_logs WHERE id = ?').run(lid)
      for (const tid of snap.txIds || []) db.prepare('DELETE FROM transactions WHERE id = ?').run(tid)
      logAudit(db, '撤回', '撤销报损 ' + (row.label || ''), { undoId: id }, operator)
    } else if (snap.kind === 'inbound') {
      // 入库：整批撤回（这批货只要被卖过/报损过就不许撤，避免把库存撤成负数）
      const b = db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(snap.batchId)
      if (!b) throw new Error('这批入库已经不在库里了')
      if (Number(b.quantity) !== Number(snap.quantity)) {
        throw new Error('这批货已经被卖过或报损过（现在剩 ' + b.quantity + '，入库时 ' + snap.quantity + '），不能整批撤回；请用退货或盘点调整')
      }
      db.prepare('DELETE FROM transactions WHERE id = ?').run(snap.txId)
      db.prepare('DELETE FROM inventory_batches WHERE id = ?').run(snap.batchId)
      logAudit(db, '撤回', '撤销入库 ' + (row.label || ''), { undoId: id }, operator)
    } else {
      throw new Error('这类操作还不支持撤回')
    }
    db.prepare('UPDATE undo_log SET undone_at = ? WHERE id = ?').run(now(), id)
    return { ok: true, undone: id, kind: snap.kind }
  })
}
