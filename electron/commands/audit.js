// 操作日志查询

/** 操作日志查询：按时间倒序，可按 action 筛选（如 '入库'/'改价'） */
export function auditLog(db, { limit = 200, action } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000)
  if (action != null && action !== '') {
    return db
      .prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(String(action), n)
  }
  return db
    .prepare('SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(n)
}
