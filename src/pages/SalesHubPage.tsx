// 销售中心（通用版 5 大导航之一）：开单/客户/收款功能归类入口
import { useMemo } from 'react'
import { ShoppingCart, RotateCcw, History, Users, ReceiptText, BadgeCheck, HandCoins } from 'lucide-react'
import { PageHeading, FeatureGrid } from '@/components/layout/FeatureGrid'
import { MetricStrip } from '@/components/layout/MetricStrip'
import { useAppStore } from '@/store/appStore'
import { isToday, formatPrice } from '@/lib/formatters'

export default function SalesHubPage() {
  const transactions = useAppStore((s) => s.transactions)
  const expenses = useAppStore((s) => s.expenses)

  const m = useMemo(() => {
    const outs = transactions.filter((t) => t.type === 'out' && isToday(t.timestamp))
    const revenue = outs.reduce((s, t) => s + (t.selling_price ?? 0) * t.quantity, 0)
    const profit = outs.reduce((s, t) => s + ((t.selling_price ?? 0) - (t.unit_price ?? 0)) * t.quantity, 0)
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
    return { revenue, profit, cnt: outs.length, monthNet: monthProf - exp }
  }, [transactions, expenses])

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeading title="销售" desc="开单收款、退货换货、客户与会员管理" icon={ShoppingCart} />
      <MetricStrip metrics={[
        { label: '今日营业额', value: formatPrice(m.revenue), sub: `${m.cnt} 笔`, tone: 'accent' },
        { label: '今日毛利', value: formatPrice(m.profit), sub: '卖货赚的', tone: m.profit > 0 ? 'positive' : 'default' },
        { label: '今日单数', value: `${m.cnt} 单`, sub: '开单笔数', tone: 'default' },
        { label: '本月净利', value: formatPrice(m.monthNet), sub: '毛利-支出', tone: m.monthNet > 0 ? 'positive' : 'default' },
      ]} />
      <FeatureGrid
        items={[
          { to: '/outbound', label: 'POS 开单', desc: '现金/微信/支付宝/赊账一键收款', icon: ShoppingCart, badge: m.cnt },
          { to: '/outbound', label: '退货换货', desc: '退旧货回补库存、换货补差价', icon: RotateCcw },
          { to: '/outbound', label: '销售历史', desc: '今日/历史单据查询与作废', icon: History },
          { to: '/customers', label: '客户管理', desc: '建档/会员/欠款/收款', icon: Users },
          { to: '/receipt-reconcile', label: '收款对账', desc: '微信/支付宝/现金实收日结', icon: ReceiptText },
          { to: '/customers', label: '会员管理', desc: '会员建档/会员价/等级', icon: BadgeCheck },
          { to: '/customers', label: '赊账管理', desc: '客户欠款/还款/对账单', icon: HandCoins },
        ]}
      />
    </div>
  )
}
