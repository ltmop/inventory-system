// 入库中心（通用版 5 大导航之一）：采购/入库功能归类入口
import { ScanBarcode, PackagePlus, History, Factory, ClipboardList, RotateCcw, FileSpreadsheet } from 'lucide-react'
import { PageHeading, FeatureGrid } from '@/components/layout/FeatureGrid'

export default function InboundHubPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeading title="入库" desc="采购进货、退货回库、供应商与采购对账" icon={PackagePlus} />
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
