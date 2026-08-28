// 分类管理（通用版）：分类表 CRUD + 排序。建档/入库/开单/报表全部动态读取。
import { inTransaction, logAudit } from './helpers.js'

/** 分类列表（按排序） */
export function listCategories(db) {
  return db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all()
}

/** 分类列表（含每类商品数） */
export function listCategoriesWithCount(db) {
  return db.prepare(
    "SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category = c.name) AS product_count FROM categories c ORDER BY c.sort_order ASC, c.id ASC",
  ).all()
}

/** 新建分类 */
export function createCategory(db, { name, icon = null, operator }) {
  const n = String(name || '').trim()
  if (!n) throw new Error('分类名不能空')
  const dup = db.prepare('SELECT id FROM categories WHERE name = ?').get(n)
  if (dup) throw new Error('分类已存在：' + n)
  return inTransaction(db, () => {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories').get()?.m ?? 0
    const info = db.prepare('INSERT INTO categories (name, sort_order, icon, template_type) VALUES (?, ?, ?, ?)')
      .run(n, max + 1, icon || null, 'custom')
    logAudit(db, '新建分类', n, null, operator)
    return db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid)
  })
}

/** 改名分类（同步商品表的分类名，报表/筛选保持一致） */
export function renameCategory(db, id, { name, operator }) {
  const n = String(name || '').trim()
  if (!n) throw new Error('分类名不能空')
  const dup = db.prepare('SELECT id FROM categories WHERE name = ? AND id <> ?').get(n, Number(id))
  if (dup) throw new Error('分类已存在：' + n)
  return inTransaction(db, () => {
    const old = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(id))
    if (!old) throw new Error('分类不存在')
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(n, Number(id))
    db.prepare('UPDATE products SET category = ? WHERE category = ?').run(n, old.name)
    logAudit(db, '改分类', old.name + ' → ' + n, null, operator)
    return db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(id))
  })
}

/** 删除分类：有商品的分类不允许删（防商品变孤儿） */
export function deleteCategory(db, id, operator) {
  return inTransaction(db, () => {
    const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(id))
    if (!c) throw new Error('分类不存在')
    const used = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category = ?').get(c.name)?.n ?? 0
    if (used > 0) throw new Error('分类「' + c.name + '」下还有 ' + used + ' 个商品，请先转移再删')
    db.prepare('DELETE FROM categories WHERE id = ?').run(Number(id))
    logAudit(db, '删分类', c.name, null, operator)
    return { ok: true }
  })
}

/** 移动分类排序（dir: -1 上移 / 1 下移） */
export function moveCategory(db, id, dir) {
  const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(id))
  if (!c) throw new Error('分类不存在')
  const list = listCategories(db)
  const idx = list.findIndex((x) => x.id === Number(id))
  const to = idx + (dir < 0 ? -1 : 1)
  if (idx < 0 || to < 0 || to >= list.length) return { ok: true, moved: false }
  return inTransaction(db, () => {
    const other = list[to]
    db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?').run(other.sort_order, c.id)
    db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?').run(c.sort_order, other.id)
    return { ok: true, moved: true }
  })
}

/** 确保分类存在（自定义输入分类时自动补录） */
export function ensureCategory(db, name) {
  const n = String(name || '').trim()
  if (!n) return
  const dup = db.prepare('SELECT id FROM categories WHERE name = ?').get(n)
  if (!dup) {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories').get()?.m ?? 0
    db.prepare('INSERT OR IGNORE INTO categories (name, sort_order, template_type) VALUES (?, ?, ?)').run(n, max + 1, 'custom')
  }
}
