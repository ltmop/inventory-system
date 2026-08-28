// 权限矩阵（v0.2）：老板/高管/店员 三档角色权限定义。
// 在命令层强制校验（不靠前端隐藏，防绕过）。
// 铁律：单机模式（未开员工登录）时所有权限放行，不影响老板直接用。

export const OWNER_ROLE = 'owner'
export const MANAGER_ROLE = 'manager'
export const STAFF_ROLE = 'staff'

export const ROLE_LABELS = {
  owner: '老板',
  manager: '高管',
  staff: '店员',
}

/** 权限点：命令层各处调 assertPermission(db, 'perm') */
export const PERMS = {
  // 基础业务（店员可用）
  operate: 'operate', // 入库/销售/盘点/报损
  // 高管 + 老板
  deleteRecord: 'deleteRecord', // 删商品/供应商/客户
  priceManage: 'priceManage', // 采购订货/改价/价签
  exportData: 'exportData', // 导出/备份/恢复
  viewReports: 'viewReports', // 报表/数据分析
  // 仅老板
  staffManage: 'staffManage', // 员工账号管理
  permissionManage: 'permissionManage', // 权限分配/身份切换
  cloudManage: 'cloudManage', // 云账号/同步管理
  settingsManage: 'settingsManage', // 系统设置/行业模板
}

// 角色 → 权限点映射
const ROLE_PERMS = {
  [OWNER_ROLE]: new Set(Object.values(PERMS)),
  [MANAGER_ROLE]: new Set([
    PERMS.operate,
    PERMS.deleteRecord,
    PERMS.priceManage,
    PERMS.exportData,
    PERMS.viewReports,
  ]),
  [STAFF_ROLE]: new Set([PERMS.operate]),
}

/** 当前用户角色（未开员工登录/无登录 → null=单机老板） */
export function currentRole(db, currentUserFn) {
  if (!db) return null
  try {
    const u = currentUserFn ? currentUserFn(db) : null
    return u ? u.role : null
  } catch {
    return null
  }
}

/** 权限校验：无权限抛错（单机模式 null=老板 全部放行） */
export function assertPermission(db, perm, currentUserFn, actionHint = '此操作') {
  const role = currentRole(db, currentUserFn)
  if (role === null || role === undefined) return // 单机模式放行
  const allowed = ROLE_PERMS[role] || new Set()
  if (!allowed.has(perm)) {
    const label = ROLE_LABELS[role] || role
    throw new Error(`${label}账号不能${actionHint}，需要更高权限`)
  }
}

/** 角色是否允许某权限（前端判断用） */
export function roleHasPerm(role, perm) {
  if (!role) return true // 单机模式
  return (ROLE_PERMS[role] || new Set()).has(perm)
}
