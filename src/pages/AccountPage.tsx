// 账号与云同步（独立页面）：登录账户 / 注册 / 立即同步 / 云端备份 / 远程看店 / 员工名单
// 身份统一第一步（2026-09-13）：这一页是**全软件唯一的账号入口**（D1）。
// 原 LoginGate（全屏员工登录门）与 CloudLoginGate（全屏云账号门）都已删除，
// StaffCard（员工名单）从设置页挪到这里 —— 登录、注册、退出、员工管理都在同一页。
import { useState } from 'react'
import { KeyRound, RefreshCcw } from 'lucide-react'
import { PageHeading } from '@/components/layout/FeatureGrid'
import { CloudCard } from './settings/CloudCard'
import { StaffCard } from './settings/StaffCard'
import { backend, setGuestMode } from '@/lib/api'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'

export default function AccountPage() {
  // 顶部说明默认只留一行，要看细节点开。
  // 原来这里是 4 步操作 + 一段「※忘了密码…」，两段散文占掉约 1/4 屏，
  // 而老板/店员真正要做的就是「输账号密码 → 登录」这一件事（owner 2026-09-14「太乱、太专业」）。
  const [help, setHelp] = useState(false)
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
      {/* 多设备使用说明：**默认一行**，要看细节点开 */}
      <div className="rounded-xl border border-lake-100 bg-lake-50/70 px-5 py-3 dark:border-slate-700 dark:bg-slate-800/70">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-slate-700 dark:text-slate-200">
            <b>多台电脑共用一个账号</b>：在这台电脑注册一次，别的电脑用<u>同一个账号密码</u>登录就行。
          </div>
          <button
            onClick={() => setHelp((v) => !v)}
            className="shrink-0 cursor-pointer text-xs font-medium text-lake-700 hover:underline dark:text-lake-300"
          >
            {help ? '收起步骤 ↑' : '看详细步骤 ↓'}
          </button>
        </div>
        {help && (
          <div className="mt-3 space-y-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            <div>1. 老板在这台电脑点「注册账户」（账号 + 密码，密码至少 6 位）</div>
            <div>2. 员工/分店电脑装同一软件 → 打开「账号与云同步」→ 输同一个账号密码登录</div>
            <div>3. 每台电脑点「立即同步」，数据就互通了（端到端加密，服务器只看得到密文）</div>
            <div>4. 换电脑/重装也不丢数据：新机器登录后点「云端备份 → 选日期恢复」</div>
            <div className="rounded-lg bg-lake-50 px-2.5 py-2 text-xs text-lake-700 dark:bg-slate-800 dark:text-lake-300">※ 忘了账号密码？<b>数据不会丢</b>——库存保存在本机、随时可用；忘密码只影响「多台电脑同步 + 云端备份」。</div>
          </div>
        )}
      </div>
      <CloudCard />
      {/* 员工名单（原在设置页）：给单据署名用；「启动必须登录」开关已随登录门一起下线 */}
      <StaffCard />
    </div>
  )
}