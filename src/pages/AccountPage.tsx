// 账号与云同步（独立页面）：登录账户 / 注册 / 立即同步 / 云端备份 / 远程看店
import { KeyRound, RefreshCcw } from 'lucide-react'
import { PageHeading } from '@/components/layout/FeatureGrid'
import { CloudCard } from './settings/CloudCard'
import { backend, setGuestMode } from '@/lib/api'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'

export default function AccountPage() {
  const cloudPaired = useAppStore((s) => s.cloud.paired)
  const setCloud = useAppStore((s) => s.setCloud)

  // 切换账号：退出当前登录 → 回到登录表单（清凭证 + 清游客标记）
  const switchAccount = async () => {
    try {
      if (backend) await backend.invoke('cloud:logout')
    } catch { /* 忽略 */ }
    setGuestMode(false)
    setCloud({ paired: false, username: null, viewUrl: null, error: null })
    useAppStore.setState({ cloudAuth: 'none' })
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeading
        title="账号与云同步"
        desc="登录账户、多设备共享数据、云端备份与远程看店"
        icon={KeyRound}
      />
      {/* 已登录：顶部提供「切换账号」快捷入口 */}
      {cloudPaired && (
        <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-5 py-3">
          <div className="text-sm text-slate-600">
            当前已登录，想换一个账号？点右侧切换（会退出当前账号并回到登录界面）
          </div>
          <Button size="sm" variant="outline" onClick={() => void switchAccount()} className="shrink-0">
            <RefreshCcw className="size-4" />
            切换账号
          </Button>
        </div>
      )}
      {/* 多设备使用说明：员工/老板如何共用一套数据 */}
      <div className="rounded-xl border border-sky-100 bg-sky-50/70 px-5 py-4">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 size-5 shrink-0 text-sky-600" />
          <div className="text-sm leading-relaxed text-slate-700">
            <div className="font-bold text-sky-800">多台电脑共用一套数据，怎么操作：</div>
            <div className="mt-1 space-y-1 text-slate-600">
              <div>1. 老板在这台电脑「注册账户」（账号 + 密码，密码至少 6 位）</div>
              <div>2. 员工/分店电脑装同一软件 → 打开「账号与云同步」→ 输入同一个账号密码登录</div>
              <div>3. 每台电脑点「立即同步」，数据就互通了（端到端加密，服务器只看得到密文）</div>
              <div>4. 换电脑/重装也不丢数据：新机器登录后点「云端备份 → 选日期恢复」</div>
            </div>
          </div>
        </div>
      </div>
      <CloudCard />
    </div>
  )
}
