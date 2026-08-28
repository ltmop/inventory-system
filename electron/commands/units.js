// 计量单位管理（通用版）：单位表 CRUD + 小数开关。allow_decimal=1 的单位开单步进 0.1、库存支持小数。
import { inTransaction, logAudit } from './helpers.js'

/** 单位列表（按排序） */
export function listUnits(db) {
  return db.prepare('SELECT * FROM units ORDER BY sort_order ASC, id ASC').all()
}

/** 新建单位 */
export function createUnit(db, { name, allow_decimal = 0, operator }) {
  const n = String(name || '').trim()
  if (!n) throw new Error('单位名不能空')
  const dup = db.prepare('SELECT id FROM units WHERE name = ?').get(n)
  if (dup) throw new Error('单位已存在：' + n)
  return inTransaction(db, () => {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM units').get()?.m ?? 0
    const info = db.prepare('INSERT INTO units (name, allow_decimal, sort_order) VALUES (?, ?, ?)')
      .run(n, allow_decimal ? 1 : 0, max + 1)
    logAudit(db, '新建单位', n + (allow_decimal ? '（可小数）' : ''), null, operator)
    return db.prepare('SELECT * FROM units WHERE id = ?').get(info.lastInsertRowid)
  })
}

/** 改单位（名字/是否小数） */
export function updateUnit(db, id, { name, allow_decimal, operator }) {
  const u = db.prepare('SELECT * FROM units WHERE id = ?').get(Number(id))
  if (!u) throw new Error('单位不存在')
  const n = name !== undefined ? String(name).trim() : u.name
  if (!n) throw new Error('单位名不能空')
  const dup = db.prepare('SELECT id FROM units WHERE name = ? AND id <> ?').get(n, Number(id))
  if (dup) throw new Error('单位已存在：' + n)
  const dec = allow_decimal !== undefined ? (allow_decimal ? 1 : 0) : u.allow_decimal
  return inTransaction(db, () => {
    db.prepare('UPDATE units SET name = ?, allow_decimal = ? WHERE id = ?').run(n, dec, Number(id))
    db.prepare('UPDATE products SET unit = ? WHERE unit = ?').run(n, u.name)
    logAudit(db, '改单位', u.name + ' → ' + n + (dec ? '（可小数）' : ''), null, operator)
    return db.prepare('SELECT * FROM units WHERE id = ?').get(Number(id))
  })
}

/** 删除单位：被商品使用的单位不允许删 */
export function deleteUnit(db, id, operator) {
  return inTransaction(db, () => {
    const u = db.prepare('SELECT * FROM units WHERE id = ?').get(Number(id))
    if (!u) throw new Error('单位不存在')
    const used = db.prepare('SELECT COUNT(*) AS n FROM products WHERE unit = ?').get(u.name)?.n ?? 0
    if (used > 0) throw new Error('单位「' + u.name + '」被 ' + used + ' 个商品使用，请先改商品单位')
    db.prepare('DELETE FROM units WHERE id = ?').run(Number(id))
    logAudit(db, '删单位', u.name, null, operator)
    return { ok: true }
  })
}

/** 移动单位排序 */
export function moveUnit(db, id, dir) {
  const u = db.prepare('SELECT * FROM units WHERE id = ?').get(Number(id))
  if (!u) throw new Error('单位不存在')
  const list = listUnits(db)
  const idx = list.findIndex((x) => x.id === Number(id))
  const to = idx + (dir < 0 ? -1 : 1)
  if (idx < 0 || to < 0 || to >= list.length) return { ok: true, moved: false }
  return inTransaction(db, () => {
    const other = list[to]
    db.prepare('UPDATE units SET sort_order = ? WHERE id = ?').run(other.sort_order, u.id)
    db.prepare('UPDATE units SET sort_order = ? WHERE id = ?').run(u.sort_order, other.id)
    return { ok: true, moved: true }
  })
}

/** 单位是否允许小数 */
export function unitAllowsDecimal(db, name) {
  const n = String(name || '').trim()
  if (!n) return false
  const u = db.prepare('SELECT allow_decimal FROM units WHERE name = ?').get(n)
  return u ? !!u.allow_decimal : false
}

/** 确保单位存在 */
export function ensureUnit(db, name, allowDecimal = 0) {
  const n = String(name || '').trim()
  if (!n) return
  const dup = db.prepare('SELECT id FROM units WHERE name = ?').get(n)
  if (!dup) {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM units').get()?.m ?? 0
    db.prepare('INSERT OR IGNORE INTO units (name, allow_decimal, sort_order) VALUES (?, ?, ?)').run(n, allowDecimal ? 1 : 0, max + 1)
  }
}
