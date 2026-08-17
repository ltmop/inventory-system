import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { useLicense } from '@/lib/license'
import { Button } from '@/components/ui/button'

interface ProGateProps {
  children: ReactNode
  fallback?: ReactNode
  /** 付费功能的简短说明，免费版显示 */
  featureDesc?: string
}

/** 付费功能门控：进阶/大师版显示内容，免费版显示"升级解锁"卡片 */
export function ProGate({ children, fallback, featureDesc }: ProGateProps) {
  const { isPaid } = useLicense()
  const navigate = useNavigate()

  if (isPaid) return <>{children}</>

  if (fallback) return <>{fallback}</>

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed border-brand-200 bg-brand-50/50 px-8 py-12 text-center">
      <div className="rounded-full bg-brand-100 p-3">
        <Lock className="size-6 text-brand-600" />
      </div>
      <div>
        <div className="text-sm font-medium text-slate-700">进阶版专属功能</div>
        {featureDesc && (
          <div className="mt-1 text-xs text-slate-500">{featureDesc}</div>
        )}
      </div>
      <Button onClick={() => navigate('/activate')} size="sm">
        升级进阶版 · ¥168/年
      </Button>
    </div>
  )
}
