import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Moon, Sun, Search, Settings, PanelLeftClose, PanelLeftOpen, AlertTriangle, UserCircle2, LogOut, CloudUpload, RefreshCw, Check } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { OfflineChip } from './OfflineBanner'
import { getCentralConfig } from '@/lib/api'
import { countLowStock } from '@/lib/stockVitals'

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
  // 低库存：**唯一判据**在 lib/stockVitals.ts。
  // 此前首页体征条用 `<=`、这里用 `<`，于是同一屏出现「顶栏 28 缺货」和「首页低库存 42」。
  const lowStockCount = useAppStore((s) => countLowStock(s.products, s.totalStockOf))
  const currentUser = useAppStore((s) => s.currentUser)
  const staffLogout = useAppStore((s) => s.staffLogout)
  // 云账号（多设备同步用）
  const cloud = useAppStore((s) => s.cloud)
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  // 「刷新界面」（2026-09-20 owner：「加一个刷新界面的按钮在右上角，不然没错的数据同步都得重启一遍」）
  //
  // 为什么需要它：数据在别处已经同步好了（中心库 / 另一台机器），但本机界面还是旧的 ——
  //   本机只在启动时 loadAll 一次，之后除非自己改数据（改完各处都会 loadAll），否则不会重拉。
  //   所以以前只能重启软件。
  //
  // ⚠️ 这里**只做软刷新**：把数据重新拉进 store，让界面跟着重渲染。
  //    绝不重挂载页面、绝不调 location.reload() ——
  //    开单页的购物车是**页面局部 state**（OutboundPage 的 useState<CartItem[]>），
  //    重挂载会把还没结的单清空；收银机上误触一下就丢单，那不是刷新是事故。
  const loadAll = useAppStore((s) => s.loadAll)
  const loadCustomers = useAppStore((s) => s.loadCustomers)
  const [refreshing, setRefreshing] = useState(false)
  const [justRefreshed, setJustRefreshed] = useState(false)

  const doRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    setJustRefreshed(false)
    try {
      await loadAll()
      // 客户是单独拉的（loadAll 不含客户）—— 它失败不该让整次刷新算失败
      await loadCustomers().catch(() => {})
      setJustRefreshed(true)
      window.setTimeout(() => setJustRefreshed(false), 2000)
    } finally {
      setRefreshing(false)
    }
  }

  // 角色中文标签
  const roleLabel = currentUser?.role === 'owner' ? '老板' : currentUser?.role === 'manager' ? '高管' : '店员'

  // 顶栏显示的「我是谁」。四种真实状态，按优先级：
  //   ① 云账号已登录（它才带得动多设备同步 + 云端备份）
  //   ② 本地员工身份
  //   ③ **中心库模式** —— 这一条以前缺了。老板的收银机跑中心库模式
  //      （localStorage `fi-central-url=https://app.junchengzn.com`，桌面/手机/网页同一本账），
  //      但没登云账号，于是顶栏一直显示「未登录」。owner 反馈「已经登录了，右上角仍然显示未登录」
  //      —— 他说的"登录"就是"连上中心库"（账号页里也正是这么写的：「已连接中心库」）。
  //      顶栏不认这一种状态，就会对着一台**正常在用的收银机**说"未登录"。
  //   ④ 都没有 → 未登录（纯本地、未连任何东西）
  const central = getCentralConfig()
  const identity = cloud.paired
    ? (cloud.username || '已登录') + '（云账号）'
    : currentUser
      ? currentUser.name + '（' + roleLabel + '）'
      : central.url
        ? '已连接中心库'
        : '未登录'
  // 悬停说清"这代表什么"，避免把「已连接中心库」误当成"云账号也登了"
  const identityHint = cloud.paired
    ? '当前身份，点击切换'
    : central.url
      ? '本机连的是门店中心库（' +
        central.url +
        '），桌面/手机同一本账；云账号未登录 —— 云账号只影响「多设备同步 + 云端备份」'
      : '当前身份，点击切换'

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

      {/* 离线/待上传（A3 离线层）：断网时店主能看见「单子在本地排队」，不会以为没记上 */}
      <OfflineChip />

      {/* 刷新界面：重新拉数据进 store，让「别处已同步、本机界面还是旧的」这种情况不用重启软件。
          只刷新数据、不重挂载页面 —— 理由见上面 doRefresh 的注释（会丢开单）。 */}
      <button
        onClick={() => void doRefresh()}
        disabled={refreshing}
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 cursor-pointer"
        title={
          refreshing
            ? '正在刷新数据…'
            : justRefreshed
              ? '已刷新'
              : '刷新界面（重新拉取数据，不用重启软件；不影响正在开的单）'
        }
        aria-label="刷新界面"
      >
        {justRefreshed ? (
          <Check className="size-5 text-emerald-500" />
        ) : (
          <RefreshCw className={refreshing ? 'size-5 animate-spin' : 'size-5'} />
        )}
      </button>

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
            title={identityHint}
          >
            <UserCircle2 className="size-5" />
            <span className="max-w-28 truncate">{identity}</span>
          </button>
          {userMenuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
                <div className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
                  当前身份：{identity}
                </div>
                {/* 全软件唯一的账号入口：登录 / 注册 / 退出 / 员工管理 都在「账号」页里 —— D1（只有一个登录入口）。
                    以前这里是两个入口（「员工登录」+「登录云账号」），owner 原话「我都不知道左上角登录还是账号里面的登录」。 */}
                <button
                  onClick={() => { setUserMenuOpen(false); navigate('/account') }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-brand-700 hover:bg-brand-50 cursor-pointer"
                >
                  <CloudUpload className="size-4" />
                  账号（登录 / 注册 / 退出）
                </button>
                {currentUser && (
                  <button
                    onClick={() => { setUserMenuOpen(false); staffLogout() }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-red-600 hover:bg-red-50 cursor-pointer"
                  >
                    <LogOut className="size-4" />
                    退出员工身份
                  </button>
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
