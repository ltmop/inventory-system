// 前端权限镜像（侧边栏按角色显隐用，纯体验）。
// 铁律：安全靠命令层 electron/commands/permissions.js 的 assertPermission，这里只是菜单裁剪；
// 两处 ROLE_PERMS 必须保持一致。单机模式（role=null）→ 全显（老板直接用）。
export type UserRole = 'owner' | 'manager' | 'staff'

export const PERMS = {
  operate: 'operate',
  deleteRecord: 'deleteRecord',
  priceManage: 'priceManage',
  exportData: 'exportData',
  viewReports: 'viewReports',
  staffManage: 'staffManage',
  permissionManage: 'permissionManage',
  cloudManage: 'cloudManage',
  settingsManage: 'settingsManage',
} as const

export type Perm = (typeof PERMS)[keyof typeof PERMS]

// 与 electron/commands/permissions.js 的 ROLE_PERMS 同源
const ROLE_PERMS: Record<UserRole, ReadonlySet<Perm>> = {
  owner: new Set(Object.values(PERMS)),
  manager: new Set([
    PERMS.operate,
    PERMS.deleteRecord,
    PERMS.priceManage,
    PERMS.exportData,
    PERMS.viewReports,
  ]),
  staff: new Set([PERMS.operate]),
}

/** 角色是否允许某权限；null（未开员工登录/单机）→ 放行 */
export function roleHasPerm(role: UserRole | null | undefined, perm: Perm): boolean {
  if (role == null) return true
  return (ROLE_PERMS[role] ?? new Set()).has(perm)
}

/** 按角色裁剪菜单项（items 带可选 perm；无 perm = 全角色可见） */
export function menuByRole<T extends { perm?: Perm }>(role: UserRole | null | undefined, items: T[]): T[] {
  if (role == null) return items // 单机全显
  return items.filter((i) => !i.perm || roleHasPerm(role, i.perm))
}
