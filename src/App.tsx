import { useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { LoginGate } from '@/components/LoginGate'
import { UpdateBanner } from '@/components/UpdateBanner'
import { Toaster } from '@/components/toast'
import { SplashScreen } from '@/components/SplashScreen'
import { Layout } from '@/components/layout/Layout'
import { DashboardPage } from '@/pages/DashboardPage'
import InboundHubPage from '@/pages/InboundHubPage'
import SalesHubPage from '@/pages/SalesHubPage'
import StockHubPage from '@/pages/StockHubPage'
import MineHubPage from '@/pages/MineHubPage'
import CategoriesPage from '@/pages/CategoriesPage'
import UnitsPage from '@/pages/UnitsPage'
import { InboundPage } from '@/pages/InboundPage'
import { OutboundPage } from '@/pages/OutboundPage'
import { InventoryPage } from '@/pages/InventoryPage'
import { StockTakePage } from '@/pages/StockTakePage'
import { PurchasePage } from '@/pages/PurchasePage'
import { SuppliersPage } from '@/pages/SuppliersPage'
import { CustomersPage } from '@/pages/CustomersPage'
import { ExpensesPage } from '@/pages/ExpensesPage'
import { WastePage } from '@/pages/WastePage'
import { ReceiptReconcilePage } from '@/pages/ReceiptReconcilePage'
import { KitsPage } from '@/pages/KitsPage'
import { AuditLogPage } from '@/pages/AuditLogPage'
import { KnowledgePage } from '@/pages/KnowledgePage'
import { HelpPage } from '@/pages/HelpPage'
import { SettingsPage } from '@/pages/SettingsPage'
import AiHubPage from '@/pages/AiHubPage'
import AccountPage from '@/pages/AccountPage'
import { ImportPage } from '@/pages/ImportPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { ReportsPage } from '@/pages/ReportsPage'
import { ActivationPage } from '@/pages/ActivationPage'
import { OnboardingPage } from '@/pages/OnboardingPage'
import { computeCustomerStats, useAppStore } from '@/store/appStore'
import { backend } from '@/lib/api'
import {
  mockAuditLogs,
  mockBatches,
  mockCustomers,
  mockExpenses,
  mockPayments,
  mockPriceTiers,
  mockProducts,
  mockPurchaseOrderItems,
  mockPurchaseOrders,
  mockStockTakeItems,
  mockStockTakes,
  mockSuppliers,
  mockTransactions,
} from '@/lib/mock-data'

/** 新手引导守门：首次启动未完成引导 → 跳 /onboarding；已完成后每次渲染 Dashboard */
function OnboardingGuard() {
  const [status, setStatus] = useState<{ checked: boolean; need: boolean }>({ checked: false, need: false })
  useEffect(() => {
    if (backend) {
      backend.invoke('onboarding:status').then((s) => {
        setStatus({ checked: true, need: !s?.completed })
      }).catch(() => setStatus({ checked: true, need: false }))
    } else {
      setStatus({ checked: true, need: false })
    }
  }, [])
  if (!status.checked) return null
  if (status.need) return <Navigate to="/onboarding" replace />
  return <DashboardPage />
}

function App() {
  const loadAll = useAppStore((s) => s.loadAll)
  const loaded = useAppStore((s) => s.loaded)
  const fontSizeMode = useAppStore((s) => s.fontSizeMode)
  const darkMode = useAppStore((s) => s.darkMode)
  const loadStaffStatus = useAppStore((s) => s.loadStaffStatus)
  // 启动动画：数据就绪后播一次，播完才挂载路由（每次启动只播一次；点击或减弱动画直接跳过）
  const [splashDone, setSplashDone] = useState(false)

  // 员工登录状态（v0.1）：数据就绪后查一次，开着员工登录就弹登录门
  useEffect(() => {
    if (loaded) void loadStaffStatus().catch(() => {})
  }, [loaded, loadStaffStatus])

  // 大字模式：给 <html> 挂 text-large class，根字号提到 18px，全站 rem 字号整体放大
  useEffect(() => {
    document.documentElement.classList.toggle('text-large', fontSizeMode === 'large')
  }, [fontSizeMode])

  // 明暗模式：默认深色；关掉挂 .light 回浅色
  useEffect(() => {
    const el = document.documentElement
    el.classList.toggle('dark', darkMode)
    el.classList.toggle('light', !darkMode)
  }, [darkMode])

  // Electron 环境启动时从 SQLite 拉全量数据；浏览器 dev 无后端则注入 mock（只跑一次，避免闪烁）
  useEffect(() => {
    if (backend) {
      loadAll()
    } else {
      useAppStore.setState({
        products: mockProducts,
        batches: mockBatches,
        transactions: mockTransactions,
        suppliers: mockSuppliers,
        stockTakes: mockStockTakes,
        stockTakeItems: mockStockTakeItems,
        customers: computeCustomerStats(mockCustomers, mockTransactions, mockPayments),
        payments: mockPayments,
        purchaseOrders: mockPurchaseOrders,
        purchaseOrderItems: mockPurchaseOrderItems,
        priceTiers: mockPriceTiers,
        expenses: mockExpenses,
        auditLogs: mockAuditLogs,
        kits: [],
        kitItems: [],
        loaded: true,
      })
    }
  }, [loadAll])

  // 数据未就绪时显示品牌加载屏，杜绝"先闪 mock 再跳真数据"
  if (!loaded) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#e8eef6]">
        <div className="text-2xl font-bold tracking-wide text-[#16355c]">AI 智能进销存系统</div>
        <div className="mt-3 text-sm text-slate-500">正在加载本地数据…</div>
      </div>
    )
  }

  return (
    <ErrorBoundary>
      {/* 员工登录门（v0.1）：开着员工登录且没人登录时覆盖全屏 */}
      <LoginGate />
      {/* 自动更新提示条：检测到新版本时底部弹出（preload 暴露 onUpdateAvailable 后生效） */}
      <UpdateBanner />
      <Toaster />
      {!splashDone && <SplashScreen onFinish={() => setSplashDone(true)} />}
      {splashDone && (
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<OnboardingGuard />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="inbound-hub" element={<InboundHubPage />} />
            <Route path="sales-hub" element={<SalesHubPage />} />
            <Route path="stock-hub" element={<StockHubPage />} />
            <Route path="mine-hub" element={<MineHubPage />} />
            <Route path="categories" element={<CategoriesPage />} />
            <Route path="units" element={<UnitsPage />} />
            <Route path="inbound" element={<InboundPage />} />
            <Route path="outbound" element={<OutboundPage />} />
            <Route path="inventory" element={<InventoryPage />} />
            <Route path="stock-take" element={<StockTakePage />} />
            <Route path="purchase" element={<PurchasePage />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="expenses" element={<ExpensesPage />} />
            <Route path="receipt-reconcile" element={<ReceiptReconcilePage />} />
            <Route path="waste" element={<WastePage />} />
            <Route path="kits" element={<KitsPage />} />
            <Route path="audit" element={<AuditLogPage />} />
            <Route path="knowledge" element={<KnowledgePage />} />
            <Route path="help" element={<HelpPage />} />
            <Route path="import" element={<ImportPage />} />
            <Route path="ai-hub" element={<AiHubPage />} />
            <Route path="account" element={<AccountPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          {/* 激活页 + 新手引导：独立全屏，不走 Layout */}
          <Route path="activate" element={<ActivationPage />} />
          <Route path="onboarding" element={<OnboardingPage />} />
        </Routes>
      </HashRouter>
      )}
    </ErrorBoundary>
  )
}

export default App