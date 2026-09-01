// 入库中心（通用版 5 大导航之一）：采购/入库功能归类入口
import { useMemo } from 'react'
import { ScanBarcode, PackagePlus, History, Factory, ClipboardList, RotateCcw, FileSpreadsheet } from 'lucide-react'
import { PageHeading, FeatureGrid } from '@/components/layout/FeatureGrid'
import { MetricStrip } from '@/components/layout/MetricStrip'
import { useAppStore } from '@/store/appStore'
import { isToday, formatPrice } from '@/lib/formatters'

export default function InboundHubPage() {
  const products = useAppStore((s) => s.products)
  const transactions = useAppStore((s) => s.transactions)
  const expenses = useAppStore((s) => s.expenses)
  const totalStockOf = useAppStore((s) => s.totalStockOf)

  const m = useMemo(() => {
    const todayIn = transactions.filter((t) => t.type === 'in' && isToday(t.timestamp))
    const todayInQty = todayIn.reduce((s, t) => s + t.quantity, 0)
    const pending = products.filter((p) => p.status === '待盘点').length
    const low = products.filter((p) => totalStockOf(p.id) <= (p.min_stock ?? 5)).length
    const now = new Date()
    const mk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const exp = expenses.filter((e) => (e.expense_date || '').startsWith(mk)).reduce((s, e) => s + e.amount, 0)
    return { todayInQty, todayInCnt: todayIn.length, pending, low, exp }
  }, [products, transactions, expenses, totalStockOf])

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeading title="入库" desc="采购进货、退货回库、供应商与采购对账" icon={PackagePlus} />
      <MetricStrip metrics={[
        { label: '今日入库', value: `+${m.todayInQty} 件`, sub: `${m.todayInCnt} 笔`, tone: 'accent' },
        { label: '待盘点', value: `${m.pending} 个`, sub: '商品待盘', tone: m.pending > 0 ? 'warning' : 'default' },
        { label: '低库存', value: `${m.low} 个`, sub: '低于预警线', tone: m.low > 0 ? 'danger' : 'default' },
        { label: '本月支出', value: formatPrice(m.exp), sub: '合计', tone: 'default' },
      ]} />
      <FeatureGrid
        items={[
          { to: '/inbound', label: '扫码入库', desc: '扫条码/搜商品，记录进价与批次', icon: ScanBarcode },
          { to: '/inbound', label: '采购收货', desc: '采购单到货一键入库', icon: ClipboardList },
          { to: '/purchase', label: '采购订货', desc: '新建采购单、跟踪到货', icon: PackagePlus },
          { to: '/inbound', label: '入库历史', desc: '近 30 天入库记录与批次', icon: History },
          { to: '/suppliers', label: '供应商管理', desc: '建档/联系方式/进货渠道', icon: Factory },
          { to: '/suppliers', label: '采购对账', desc: '供应商应付/已付/欠款', icon: FileSpreadsheet },
          { to: '/outbound', label: '退货入库', desc: '客户退货回补库存', icon: RotateCcw },
        ]}
      />
    </div>
  )
}
