import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  PackagePlus,
  ShoppingCart,
  PackageSearch,
  User,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  KeyRound,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { BrandLogo } from '@/components/BrandLogo'
import { APP_VERSION } from '@/lib/version'
import { useAppStore } from '@/store/appStore'
import { menuByRole, PERMS, type Perm } from '@/lib/permissions'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  perm?: Perm
}

// 主导航：业务功能按场景归类（perm=operate 的店员可见；无 perm=全角色可见）
const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '首页', icon: LayoutDashboard, end: true },
  { to: '/inbound-hub', label: '入库', icon: PackagePlus, perm: PERMS.operate },
  { to: '/sales-hub', label: '销售', icon: ShoppingCart, perm: PERMS.operate },
  { to: '/stock-hub', label: '库存', icon: PackageSearch, perm: PERMS.operate },
  { to: '/mine-hub', label: '我的', icon: User },
]

// 底部固定区：账号（左下角）+ 设置在账号下方；账号=云/员工管理、设置=系统设置，仅老板可见
const BOTTOM_ITEMS: NavItem[] = [
  { to: '/account', label: '账号', icon: KeyRound, end: true, perm: PERMS.cloudManage },
  { to: '/settings', label: '设置', icon: Settings, end: true, perm: PERMS.settingsManage },
]

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  // 当前角色：未开员工登录/单机 → null → 全显（老板直接用）
  const role = useAppStore((s) => s.currentUser)?.role ?? null
  const navItems = menuByRole(role, NAV_ITEMS)
  const bottomItems = menuByRole(role, BOTTOM_ITEMS)

  return (
    <aside
      className={cn(
        'relative flex h-screen flex-col overflow-hidden border-r border-slate-200 bg-white transition-all duration-200',
        collapsed ? 'w-0 border-r-0' : 'w-56',
      )}
    >
      {/* 品牌区：蓝底白字 LOGO */}
      <div className={cn('flex items-center gap-2.5 px-4 py-5', collapsed && 'justify-center px-0')}>
        <BrandLogo size={40} className="shadow-sm" />
        {!collapsed && (
          <div className="leading-tight">
            <div className="text-[15px] font-bold text-slate-900">AI 智能进销存</div>
            <div className="text-xs text-slate-400">AI 智能管理系统</div>
          </div>
        )}
      </div>

      {/* 主导航：业务功能 */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            title={item.label}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-lg text-sm font-medium transition-all duration-150',
                collapsed ? 'justify-center px-0 py-3' : 'px-3 py-2.5',
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
              )
            }
          >
            <item.icon className={cn('shrink-0', collapsed ? 'size-5' : 'size-4.5')} />
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* 底部固定区：账号（左下角）+ 设置（账号下方） */}
      <div className="shrink-0 border-t border-slate-100 px-2 py-2">
        <nav className="space-y-1">
          {bottomItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={item.label}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg text-sm font-medium transition-all duration-150',
                  collapsed ? 'justify-center px-0 py-3' : 'px-3 py-2.5',
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                )
              }
            >
              <item.icon className={cn('shrink-0', collapsed ? 'size-5' : 'size-4.5')} />
              {!collapsed && <span>{item.label}</span>}
            </NavLink>
          ))}
        </nav>
        {!collapsed && (
          <div className="px-3 pt-1 text-[11px] text-slate-400">v{APP_VERSION}</div>
        )}
      </div>
      <button
        onClick={onToggle}
        className="m-2 flex items-center justify-center rounded-md p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-700 cursor-pointer"
        title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
      >
        {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
      </button>
    </aside>
  )
}
