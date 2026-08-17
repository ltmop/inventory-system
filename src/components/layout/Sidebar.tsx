import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  ScanBarcode,
  PackageSearch,
  ClipboardCheck,
  ClipboardList,
  Factory,
  Users,
  PackageMinus,
  BarChart3,
  FileUp,
  Fish,
  ScrollText,
  Settings,
  Wallet,
  ReceiptText,
  PackageX,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { APP_VERSION } from '@/lib/version'

// 一级：每天用的进/销/存；二级：偶尔用的管理功能
const DAILY_ITEMS = [
  { to: '/inbound', label: '扫码入库', icon: ScanBarcode, iconColor: 'text-sky-400' },
  { to: '/outbound', label: '销售出库', icon: PackageMinus, iconColor: 'text-orange-400' },
  { to: '/inventory', label: '库存查询', icon: PackageSearch, iconColor: 'text-emerald-400' },
]

const ADMIN_ITEMS = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard, end: true },
  { to: '/reports', label: '经营报表', icon: BarChart3 },
  { to: '/expenses', label: '支出记账', icon: Wallet },
  { to: '/receipt-reconcile', label: '收款对账', icon: ReceiptText },
  { to: '/waste', label: '报损登记', icon: PackageX },
  { to: '/kits', label: '套装管理', icon: PackageOpen },
  { to: '/purchase', label: '采购订货', icon: ClipboardList },
  { to: '/stock-take', label: '盘点管理', icon: ClipboardCheck },
  { to: '/customers', label: '客户', icon: Users },
  { to: '/suppliers', label: '供应商', icon: Factory },
  { to: '/import', label: '批量导入', icon: FileUp },
  { to: '/audit', label: '操作日志', icon: ScrollText },
  { to: '/settings', label: '设置', icon: Settings },
]

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

function NavItem({
  to,
  label,
  icon: Icon,
  end,
  iconColor,
  collapsed,
  large,
}: {
  to: string
  label: string
  icon: typeof Fish
  end?: boolean
  iconColor?: string
  collapsed: boolean
  large?: boolean
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md text-sm font-medium transition-all duration-150',
          collapsed ? 'justify-center px-0 py-2.5' : large ? 'px-3 py-2.5' : 'px-3 py-2',
          isActive
            ? 'border-l-[3px] border-gold-400 bg-gradient-to-r from-gold-500/25 to-gold-500/5 text-gold-100'
            : 'text-white/70 hover:bg-white/10 hover:text-white',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn(
              'shrink-0',
              large ? 'size-5' : 'size-4.5',
              isActive ? 'text-white' : iconColor,
            )}
          />
          {!collapsed && <span className={large ? 'text-[15px]' : ''}>{label}</span>}
        </>
      )}
    </NavLink>
  )
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      className={cn(
        'relative flex h-screen flex-col overflow-hidden bg-gradient-to-b from-brand-800 to-brand-900 transition-all duration-200 dark:from-[#0d1b30] dark:to-[#081426] dark:border-r dark:border-[#1a2c48]',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      {/* 底部金色氛围光晕 */}
      <div className="pointer-events-none absolute -bottom-24 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-gold-500/10 blur-3xl" />
      <div className={cn('flex items-center gap-2.5 px-4 py-5', collapsed && 'justify-center px-0')}>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-gold-400 to-gold-600 shadow-lg shadow-gold-900/50 ring-1 ring-gold-200/40">
          <Fish className="size-5 text-[#0a1628]" />
        </div>
        {!collapsed && (
          <div className="leading-tight">
            <div className="text-sm font-bold text-white">通用进销存</div>
            <div className="text-xs text-gold-200/70">AI 智能进销存</div>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2">
        <div className="space-y-1">
          {!collapsed && (
            <div className="px-3 pb-1 text-[11px] font-medium tracking-wider text-gold-200/60">
              日常操作
            </div>
          )}
          {DAILY_ITEMS.map((item) => (
            <NavItem key={item.to} {...item} collapsed={collapsed} large />
          ))}
        </div>
        <div className="space-y-1 pt-3">
          {!collapsed && (
            <>
              {/* 水波纹分隔：渐变细线，像水面波纹 */}
              <div className="mx-3 mb-2 h-px bg-gradient-to-r from-transparent via-lake-400/40 to-transparent" />
              <div className="px-3 pb-1 text-[11px] font-medium tracking-wider text-gold-200/60">
                管理
              </div>
            </>
          )}
          {ADMIN_ITEMS.map((item) => (
            <NavItem key={item.to} {...item} collapsed={collapsed} />
          ))}
        </div>
      </nav>

      {!collapsed && (
        <div className="px-4 pb-1 text-[11px] text-gold-200/50">v{APP_VERSION} · 阿东 © 2026</div>
      )}
      <button
        onClick={onToggle}
        className="m-2 flex items-center justify-center rounded-md p-2 text-white/60 hover:bg-white/10 hover:text-white cursor-pointer"
        title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
      >
        {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
      </button>
    </aside>
  )
}
