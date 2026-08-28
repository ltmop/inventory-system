// 库存中心（通用版 5 大导航之一）：商品/库存管理功能归类入口
import { PackageSearch, ClipboardCheck, PackageX, TriangleAlert, Boxes, Tags, Ruler, PackageOpen, ScanBarcode, TrendingDown } from 'lucide-react'
import { PageHeading, FeatureGrid } from '@/components/layout/FeatureGrid'
import { useAppStore } from '@/store/appStore'
import { useMemo } from 'react'

export default function StockHubPage() {
  const products = useAppStore((s) => s.products)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const expiringCount = useMemo(() => products.filter((p) => {
    const min = p.min_stock ?? 5
    const stock = totalStockOf(p.id)
    return stock > 0 && stock <= min
  }).length, [products, totalStockOf])
  const lowCount = useMemo(() => products.filter((p) => totalStockOf(p.id) <= (p.min_stock ?? 5)).length, [products, totalStockOf])
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeading title="库存" desc="库存查询、盘点报损、商品与分类单位管理" icon={PackageSearch} />
      <FeatureGrid
        items={[
          { to: '/inventory', label: '库存查询', desc: '商品列表/批次/货位/价格', icon: PackageSearch, badge: lowCount },
          { to: '/stock-take', label: '盘点管理', desc: '按批次/SKU 盘实盘数', icon: ClipboardCheck },
          { to: '/waste', label: '报损登记', desc: '破损/临期/过期报损', icon: PackageX },
          { to: '/inventory', label: '临期预警', desc: 'N 天内到期批次提醒', icon: TriangleAlert, badge: expiringCount },
          { to: '/inventory', label: '低库存预警', desc: '缺货/低于缺货线商品', icon: TrendingDown, badge: lowCount },
          { to: '/inventory', label: '商品建档/编辑', desc: '新增商品、拍照、改价', icon: Boxes },
          { to: '/categories', label: '分类管理', desc: '增删改/排序分类', icon: Tags, isNew: true },
          { to: '/units', label: '单位管理', desc: '计量单位/小数开关', icon: Ruler, isNew: true },
          { to: '/kits', label: '组合商品', desc: '多商品打包一口价', icon: PackageOpen },
          { to: '/inventory', label: '条码管理', desc: '扫码建档/查条码', icon: ScanBarcode },
        ]}
      />
    </div>
  )
}
