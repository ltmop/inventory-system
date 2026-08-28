// 我的（通用版 5 大导航之一）：店铺信息/报表/支出/备份/云同步
import { Store, BarChart3, Wallet, DatabaseBackup, Cloud, MonitorSmartphone, Settings } from 'lucide-react'
import { PageHeading, FeatureGrid } from '@/components/layout/FeatureGrid'

export default function MineHubPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeading title="我的" desc="店铺信息、经营报表、数据备份与云同步" icon={Store} />
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
