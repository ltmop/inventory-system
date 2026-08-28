// 员工账号（v0.1）：本地多用户登录 + 老板/店员角色。
// 铁律：
// 1. 默认关闭（settings.staff_login != 'on' 时零影响，单机老板照旧直接用）
// 2. 密码 scrypt 加盐哈希，绝不存明文；任何环节挂掉不阻断软件启动
// 3. owner 至少保留 1 个；配额按版本（users 上限 2/10/无限）在创建时拦截
import crypto from 'node:crypto'
import { logAudit } from './helpers.js'
import { readLevelFromDb, planFor } from '../license.js'
import { OWNER_ROLE, MANAGER_ROLE, STAFF_ROLE, ROLE_LABELS, assertPermission, PERMS } from './permissions.js'

// 兼容导出（其他文件可能引用）
export { OWNER_ROLE, STAFF_ROLE }

/** scrypt 哈希：`scrypt:N:盐:哈希` 三段 base64（N=16384，单机量级足够） */
function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 })
  return `scrypt:16384:${salt.toString('base64')}:${hash.toString('base64')}`
}

function verifyPassword(password, stored) {
  try {
    const [algo, n, saltB64, hashB64] = String(stored).split(':')
    if (algo !== 'scrypt') return false
    const hash = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), 32, {
      N: Number(n) || 16384, r: 8, p: 1,
    })
    return crypto.timingSafeEqual(hash, Buffer.from(hashB64, 'base64'))
  } catch {
    return false
  }
}

/** 员工总数（配额统计口径） */
export function userCount(db) {
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n ?? 0
  } catch {
    return 0
  }
}

/** 员工列表（不含密码哈希，前端展示用） */
export function listUsers(db) {
  return db
    .prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY id')
    .all()
}

/** 员工登录开关（settings 键 staff_login='on' 才启用登录门） */
export function staffLoginEnabled(db) {
  try {
    return db.prepare("SELECT value FROM settings WHERE key = 'staff_login'").get()?.value === 'on'
  } catch {
    return false
  }
}

/** 开/关员工登录（开关由老板在设置页操作） */
export function setStaffLogin(db, on, operator = null) {
  assertBossAction(db, '开关员工登录')
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('staff_login', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(on ? 'on' : 'off')
  logAudit(db, on ? '开启员工登录' : '关闭员工登录', null, null, operator)
  return { enabled: on }
}

/** 当前登录用户（settings 键 current_user 存用户名；没登录/关闭开关时返回 null） */
export function currentUser(db) {
  if (!staffLoginEnabled(db)) return null
  const uname = db.prepare("SELECT value FROM settings WHERE key = 'current_user'").get()?.value
  if (!uname) return null
  const u = db.prepare('SELECT id, name, username, role, active FROM users WHERE username = ?').get(uname)
  return u && u.active ? u : null
}

/** 删除类权限拦截（删除商品/供应商/客户等）：需要 deleteRecord 权限（老板+高管）。
 *  没开员工登录（单机模式）→ 放行。 */
export function assertOwnerAction(db, action) {
  assertPermission(db, PERMS.deleteRecord, currentUser, action)
}

/** 老板专属拦截（员工管理/权限/云账号/设置）：需要 staffManage 权限（仅老板）。 */
export function assertBossAction(db, action) {
  assertPermission(db, PERMS.staffManage, currentUser, action)
}

/** 通用权限拦截：按权限点校验（供各命令层调用） */
export function assertPerm(db, perm, action) {
  assertPermission(db, perm, currentUser, action)
}

/** 登录：校验账号密码，成功后把 current_user 写入 settings */
export function login(db, { username, password }) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').trim())
  if (!row) throw new Error('账号不存在')
  if (!row.active) throw new Error('该账号已停用')
  if (!verifyPassword(password, row.password_hash)) throw new Error('密码不对')
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('current_user', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(row.username)
  logAudit(db, '登录', row.name, null, row.username)
  return { id: row.id, name: row.name, username: row.username, role: row.role }
}

/** 登出：清掉 current_user */
export function logout(db) {
  db.prepare("DELETE FROM settings WHERE key = 'current_user'").run()
  return { ok: true }
}

/** 建员工（或第一个老板）：按版本配额拦截人数；role 只能是 owner/manager/staff */
export function createUser(db, { name, username, password, role = STAFF_ROLE }, operator = null) {
  // 老板专属：员工账号管理（首个老板=单机模式放行）
  assertBossAction(db, '管理员工账号')
  const uname = String(username ?? '').trim()
  if (!uname || uname.length < 2) throw new Error('登录名至少 2 个字')
  if (String(password ?? '').length < 4) throw new Error('密码至少 4 位')
  if (![OWNER_ROLE, MANAGER_ROLE, STAFF_ROLE].includes(role)) throw new Error('角色不对')
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(uname)) throw new Error('登录名已存在')
  // 配额：人数按版本上限（含老板自己）；大师版不限
  const level = readLevelFromDb(db)
  const limit = planFor(level).users
  const used = userCount(db)
  if (Number.isFinite(limit) && used >= limit) {
    throw new Error(`当前版本最多 ${limit} 个员工账号（已用 ${used} 个），升级进阶版/大师版可加更多`)
  }
  const info = db
    .prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(String(name ?? '').trim() || uname, uname, hashPassword(password), role)
  logAudit(db, '新建员工', `${uname}（${ROLE_LABELS[role] || role}）`, null, operator)
  return { id: Number(info.lastInsertRowid) }
}

/** 改员工：改名/改密码（不传密码则不改）/角色/停启用 */
export function updateUser(db, id, { name, password, role, active }, operator = null) {
  assertBossAction(db, '修改员工账号')
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
  if (!row) throw new Error('账号不存在')
  if (row.role === OWNER_ROLE && role && role !== OWNER_ROLE) throw new Error('老板账号不能降为店员')
  if (row.role === OWNER_ROLE && active === 0) {
    // 停用老板前检查是否还有别的 active owner
    const others = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1 AND id != ?")
      .get(id).n
    if (others === 0) throw new Error('至少要留一个可用的老板账号')
  }
  const newName = name !== undefined ? String(name).trim() : row.name
  const newRole = role ?? row.role
  const newActive = active === undefined ? row.active : active ? 1 : 0
  if (password) {
    db.prepare('UPDATE users SET name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?').run(
      newName, newRole, newActive, hashPassword(password), id,
    )
  } else {
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(
      newName, newRole, newActive, id,
    )
  }
  logAudit(db, '改员工', row.username, { name: newName, role: newRole, active: newActive }, operator)
  return { ok: true }
}

/** 删员工：不能删老板；删掉后该账号登录立刻失效 */
export function deleteUser(db, id, operator = null) {
  assertBossAction(db, '删除员工账号')
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
  if (!row) throw new Error('账号不存在')
  if (row.role === OWNER_ROLE) throw new Error('老板账号不能删')
  db.prepare('DELETE FROM users WHERE id = ?').run(id)
  db.prepare("DELETE FROM settings WHERE key = 'current_user' AND value = ?").run(row.username)
  logAudit(db, '删员工', row.username, null, operator)
  return { ok: true }
}
