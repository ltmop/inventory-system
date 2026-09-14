// 入库中心（通用版 5 大导航之一）：采购/入库功能归类入口
import { useMemo } from 'react'
import { ScanBarcode, PackagePlus, Factory, RotateCcw, FileSpreadsheet } from 'lucide-react'
import { PageHeading, FeatureGrid } from '@/components/layout/FeatureGrid'
import { MetricStrip } from '@/components/layout/MetricStrip'
import { useAppStore } from '@/store/appStore'
import { isToday, formatPrice } from '@/lib/formatters'
import { countLowStock } from '@/lib/stockVitals'

export default function InboundHubPage() {
  const products = useAppStore((s) => s.products)
  const transactions = useAppStore((s) => s.transactions)
  const expenses = useAppStore((s) => s.expenses)
  const totalStockOf = useAppStore((s) => s.totalStockOf)

  const m = useMemo(() => {
    const todayIn = transactions.filter((t) => t.type === 'in' && isToday(t.timestamp))
    const todayInQty = todayIn.reduce((s, t) => s + t.quantity, 0)
    const pending = products.filter((p) => p.status === '待盘点').length
    const low = countLowStock(products, totalStockOf)
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
          // 2026-09-14 去重：原来 7 张卡里有 3 张都指向 /inbound（扫码入库 / 采购收货 / 入库历史），
          // 点「采购收货」落到的是跟「扫码入库」同一个页面 —— 那是假导航，只会让人更迷糊。
          // 同时新增「批量导入 Excel」：这条路一直存在（/import，带模板下载 + 逐行校验），
          // 但以前只有 Ctrl+K 搜得到，所以老板只能扫码一件件录（owner：「库存批量输入数据困难」）。
          { to: '/inbound', label: '扫码入库', desc: '扫条码/搜商品，记进价与批次', icon: ScanBarcode },
          { to: '/import', label: '批量导入 Excel', desc: '一张表把整批货导进来，附模板', icon: FileSpreadsheet },
          { to: '/purchase', label: '采购订货', desc: '新建采购单、跟踪到货', icon: PackagePlus },
          { to: '/suppliers', label: '供应商与对账', desc: '建档/账期/应付欠款', icon: Factory },
          { to: '/outbound', label: '退货入库', desc: '客户退货回补库存', icon: RotateCcw },
        ]}
      />
    </div>
  )
}
