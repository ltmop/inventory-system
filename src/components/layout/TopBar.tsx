import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Moon, Sun, Search, Settings, PanelLeftClose, PanelLeftOpen, AlertTriangle, UserCircle2, LogOut, CloudUpload, UserPlus } from 'lucide-react'
import { useAppStore } from '@/store/appStore'

// 路由 → 页面标题，顶栏左侧显示当前在哪一页
const TITLE_MAP: Record<string, string> = {
  '/': '首页',
  '/inbound-hub': '入库',
  '/sales-hub': '销售',
  '/stock-hub': '库存',
  '/mine-hub': '我的',
  '/account': '账号',
  '/categories': '分类管理',
  '/units': '单位管理',
  '/reports': '经营报表',
  '/inbound': '入库',
  '/outbound': '销售',
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
  const currentUser = useAppStore((s) => s.currentUser)
  const staffLogout = useAppStore((s) => s.staffLogout)
  const setLoginGateOpen = useAppStore((s) => s.setLoginGateOpen)
  // 云账号（多设备同步用，与「员工登录」是两套账号，别混）
  const cloud = useAppStore((s) => s.cloud)
  const openCloudGate = useAppStore((s) => s.openCloudGate)
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  // 角色中文标签
  const roleLabel = currentUser?.role === 'owner' ? '老板' : currentUser?.role === 'manager' ? '高管' : '店员'

  const title = useMemo(() => {
    const exact = TITLE_MAP[location.pathname]
    if (exact) return exact
    // 子路径回退到一级
    const first = '/' + location.pathname.split('/')[1]
    return TITLE_MAP[first] || 'AI 智能进销存'
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
        <span className="hidden text-xs text-slate-400 dark:text-slate-500 sm:inline">AI 智能进销存系统</span>
      </div>

      <div className="flex-1" />

      {/* 全局搜索提示（Ctrl+K）：点击打开命令面板，不是跳首页 */}
      <button
        onClick={() => window.dispatchEvent(new Event('open-command-palette'))}
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

      {/* 身份显示 + 切换/登录（始终显示：店员一眼知道怎么登录） */}
      <div className="relative">
          <button
            onClick={() => setUserMenuOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer"
            title="当前身份，点击切换"
          >
            <UserCircle2 className="size-5" />
            <span className="max-w-24 truncate">{currentUser ? currentUser.name + ' / ' + roleLabel : '未登录'}</span>
          </button>
          {userMenuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                <div className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
                  当前身份：{currentUser ? currentUser.name + '（' + roleLabel + '）' : '未登录'}
                </div>
                {currentUser ? (
                  <button
                    onClick={() => { setUserMenuOpen(false); staffLogout() }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-red-600 hover:bg-red-50 cursor-pointer"
                  >
                    <LogOut className="size-4" />
                    退出当前身份
                  </button>
                ) : (
                  <button
                    onClick={() => { setUserMenuOpen(false); setLoginGateOpen(true) }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-slate-600 hover:bg-slate-50 cursor-pointer"
                  >
                    <UserCircle2 className="size-4" />
                    员工登录（店员/老板）
                  </button>
                )}

                {/* 云账号（多设备同步）：与上面「员工登录」是两套账号。
                    以前这里没有任何云账号入口，店主只能从内容区横幅摸进去，导致「登不上/注册不了/同步不了」。 */}
                <div className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
                  云账号（多设备同步）：
                  {cloud.paired
                    ? <span className="font-medium text-emerald-600">{cloud.username || '已登录'}</span>
                    : <span className="text-amber-600">未登录 · 数据只在这台电脑</span>}
                </div>
                {cloud.paired ? (
                  <button
                    onClick={() => { setUserMenuOpen(false); navigate('/account') }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-slate-600 hover:bg-slate-50 cursor-pointer"
                  >
                    <CloudUpload className="size-4" />
                    同步与账号设置
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => { setUserMenuOpen(false); openCloudGate('login') }}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-brand-700 hover:bg-brand-50 cursor-pointer"
                    >
                      <CloudUpload className="size-4" />
                      登录云账号（多台电脑同步）
                    </button>
                    <button
                      onClick={() => { setUserMenuOpen(false); openCloudGate('register') }}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-brand-700 hover:bg-brand-50 cursor-pointer"
                    >
                      <UserPlus className="size-4" />
                      注册云账号（新店首次开通）
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>

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
