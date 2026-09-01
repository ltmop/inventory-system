// 我的（通用版 5 大导航之一）：店铺信息/报表/支出/备份/云同步
import { useMemo } from 'react'
import { Store, BarChart3, Wallet, DatabaseBackup, Cloud, MonitorSmartphone, Settings } from 'lucide-react'
import { PageHeading, FeatureGrid } from '@/components/layout/FeatureGrid'
import { MetricStrip } from '@/components/layout/MetricStrip'
import { useAppStore } from '@/store/appStore'
import { isToday, formatPrice } from '@/lib/formatters'

export default function MineHubPage() {
  const products = useAppStore((s) => s.products)
  const transactions = useAppStore((s) => s.transactions)
  const expenses = useAppStore((s) => s.expenses)

  const m = useMemo(() => {
    const now = new Date()
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
    let monthRev = 0, monthProf = 0
    for (const t of transactions) {
      if (t.timestamp < mStart || t.timestamp >= mEnd) continue
      if (t.type === 'out') {
        if (t.selling_price != null) monthRev += t.selling_price * t.quantity
        if (t.selling_price != null && t.unit_price != null) monthProf += (t.selling_price - t.unit_price) * t.quantity
      } else if (t.type === 'return' && t.notes !== '换货退旧') {
        if (t.selling_price != null) monthRev -= t.selling_price * t.quantity
        if (t.selling_price != null && t.unit_price != null) monthProf -= (t.selling_price - t.unit_price) * t.quantity
      }
    }
    const mk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const exp = expenses.filter((e) => (e.expense_date || '').startsWith(mk)).reduce((s, e) => s + e.amount, 0)
    const todayRev = transactions.filter((t) => t.type === 'out' && isToday(t.timestamp)).reduce((s, t) => s + (t.selling_price ?? 0) * t.quantity, 0)
    return { monthNet: monthProf - exp, exp, todayRev, total: products.length }
  }, [transactions, expenses, products])

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeading title="我的" desc="店铺信息、经营报表、数据备份与云同步" icon={Store} />
      <MetricStrip metrics={[
        { label: '本月净利', value: formatPrice(m.monthNet), sub: '毛利-支出', tone: m.monthNet > 0 ? 'positive' : 'default' },
        { label: '本月支出', value: formatPrice(m.exp), sub: '合计', tone: 'default' },
        { label: '今日营业额', value: formatPrice(m.todayRev), sub: '实时', tone: 'accent' },
        { label: '商品总数', value: `${m.total} 个`, sub: 'SKU', tone: 'default' },
      ]} />
      <FeatureGrid
        items={[
          { to: '/reports', label: '经营报表', desc: '日/月/年营业额、毛利、净利', icon: BarChart3 },
          { to: '/expenses', label: '支出记录', desc: '房租/水电/运费/人工记账', icon: Wallet },
          { to: '/settings', label: '店铺信息', desc: '店名/主题/员工模式', icon: Store },
          { to: '/settings', label: '数据备份/恢复', desc: '本地备份/恢复/导出', icon: DatabaseBackup },
          { to: '/settings', label: '云同步', desc: '多设备数据互通', icon: Cloud },
          { to: '/settings', label: '多设备管理', desc: '手机看店/局域网服务', icon: MonitorSmartphone },
          { to: '/audit', label: '操作日志', desc: '关键操作留痕', icon: Settings },
        ]}
      />
    </div>
  )
}
