// 销售中心（通用版 5 大导航之一）：开单/客户/收款功能归类入口
import { ShoppingCart, RotateCcw, History, Users, ReceiptText, BadgeCheck, HandCoins } from 'lucide-react'
import { PageHeading, FeatureGrid } from '@/components/layout/FeatureGrid'

export default function SalesHubPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeading title="销售" desc="开单收款、退货换货、客户与会员管理" icon={ShoppingCart} />
      <FeatureGrid
        items={[
          { to: '/outbound', label: 'POS 开单', desc: '现金/微信/支付宝/赊账一键收款', icon: ShoppingCart },
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
