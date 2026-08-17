import { useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Moon, Sun, Search, Settings, PanelLeftClose, PanelLeftOpen, AlertTriangle } from 'lucide-react'
import { useAppStore } from '@/store/appStore'

// 路由 → 页面标题，顶栏左侧显示当前在哪一页
const TITLE_MAP: Record<string, string> = {
  '/': '仪表盘',
  '/reports': '经营报表',
  '/inbound': '扫码入库',
  '/outbound': '销售出库',
  '/inventory': '库存查询',
  '/stock-take': '盘点管理',
  '/purchase': '采购订货',
  '/customers': '客户管理',
  '/suppliers': '供应商',
  '/expenses': '支出记账',
  '/import': '批量导入',
  '/audit': '操作日志',
  '/settings': '设置',
}

export function TopBar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const darkMode = useAppStore((s) => s.darkMode)
  const setDarkMode = useAppStore((s) => s.setDarkMode)
  const lowStockCount = useAppStore((s) => s.products.filter((p) => s.totalStockOf(p.id) < (p.min_stock ?? 5)).length)

  const title = useMemo(() => {
    const exact = TITLE_MAP[location.pathname]
    if (exact) return exact
    // 子路径回退到一级
    const first = '/' + location.pathname.split('/')[1]
    return TITLE_MAP[first] || '通用进销存'
  }, [location.pathname])

  return (
    <header className="sticky top-0 z-40 flex h-[60px] items-center gap-3 border-b border-slate-200/70 bg-white/80 px-4 backdrop-blur-md dark:border-[#243755] dark:bg-[#0a1628]/80">
      {/* 折叠侧边栏 */}
      <button
        onClick={onToggle}
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 cursor-pointer"
        title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
      >
        {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
      </button>

      {/* 当前页面标题 */}
      <div className="flex items-baseline gap-2">
        <span className="text-base font-semibold text-slate-800 dark:text-slate-100">{title}</span>
        <span className="hidden text-xs text-slate-400 dark:text-slate-500 sm:inline">通用进销存系统</span>
      </div>

      <div className="flex-1" />

      {/* 全局搜索提示（Ctrl+K） */}
      <button
        onClick={() => navigate('/')}
        className="hidden items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-400 transition-colors hover:border-slate-300 hover:text-slate-500 dark:border-[#243755] dark:text-slate-500 dark:hover:border-slate-600 md:flex cursor-pointer"
      >
        <Search className="size-4" />
        <span>搜索 / 快捷跳转</span>
        <kbd className="rounded border border-slate-200 bg-slate-50 px-1 text-[10px] text-slate-400 dark:border-[#243755] dark:bg-slate-800 dark:text-slate-500">Ctrl K</kbd>
      </button>

      {/* 低库存提示 */}
      {lowStockCount > 0 && (
        <button
          onClick={() => navigate('/inventory?filter=low')}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30 cursor-pointer"
          title={`${lowStockCount} 个商品库存不足`}
        >
          <AlertTriangle className="size-4" />
          <span className="hidden sm:inline">{lowStockCount} 缺货</span>
        </button>
      )}

      {/* 明暗切换 */}
      <button
        onClick={() => setDarkMode(!darkMode)}
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-gold-400 dark:hover:bg-slate-800 cursor-pointer"
        title={darkMode ? '切换到浅色' : '切换到深色'}
      >
        {darkMode ? <Sun className="size-5" /> : <Moon className="size-5" />}
      </button>

      {/* 设置入口 */}
      <button
        onClick={() => navigate('/settings')}
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 cursor-pointer"
        title="设置"
      >
        <Settings className="size-5" />
      </button>
    </header>
  )
}
