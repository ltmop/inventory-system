// 游客只读模式提示卡：跳过登录后，在操作页顶部显示「需登录才能操作」的遮挡提示
import { Lock } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { setGuestMode } from '@/lib/api'
import { Button } from '@/components/ui/button'

export function GuestBlockCard({ title }: { title: string }) {
  const cloudAuth = useAppStore((s) => s.cloudAuth)
  if (cloudAuth !== 'guest') return null
  return (
    <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
          <Lock className="size-5" />
        </div>
        <div>
          <div className="text-sm font-bold text-amber-800">{title}需要登录账号</div>
          <div className="mt-0.5 text-xs text-amber-700">
            当前是只读演示模式，登录云账号后即可正常{title}
          </div>
        </div>
      </div>
      <Button
        size="sm"
        className="shrink-0 bg-amber-600 hover:bg-amber-700"
        onClick={() => {
          setGuestMode(false)
          useAppStore.setState({ cloudAuth: 'none' })
        }}
      >
        去登录
      </Button>
    </div>
  )
}
