// 本地模式提示卡：未登录云账号时，在操作页顶部提示「数据仅在本机」，可随时登录同步（不再拦截操作）
import { CloudOff } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { setGuestMode } from '@/lib/api'
import { Button } from '@/components/ui/button'

export function GuestBlockCard({ title }: { title: string }) {
  const cloudAuth = useAppStore((s) => s.cloudAuth)
  if (cloudAuth !== 'guest') return null
  return (
    <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-sky-200 bg-sky-50 px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
          <CloudOff className="size-5" />
        </div>
        <div>
          <div className="text-sm font-bold text-sky-800">本地模式：{title}照常可用，数据存在这台电脑</div>
          <div className="mt-0.5 text-xs text-sky-700">
            登录云账号后，多台电脑自动同步、云端备份，换机不丢账
          </div>
        </div>
      </div>
      <Button
        size="sm"
        className="shrink-0 bg-sky-600 hover:bg-sky-700"
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
