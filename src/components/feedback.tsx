import { useEffect, useRef, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { toast } from '@/components/toast'

/** 统一页面标题区：主标题 + 副标题说明 */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
      </div>
      {action}
    </div>
  )
}

/** 操作成功反馈：改为全局浮层 toast（自动消失、不推挤布局）。
 * 保持同名组件便于页面零改动：挂载即触发 toast，不再渲染内联横幅。 */
export function SuccessBanner({ children }: { children: ReactNode }) {
  const last = useRef<string | null>(null)
  const msg = typeof children === 'string' ? children : String(children ?? '')
  useEffect(() => {
    if (!msg || last.current === msg) return
    last.current = msg
    toast.success(msg)
  }, [msg])
  return null
}

/** 操作失败/校验错误反馈 */
export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: 'spring', stiffness: 500, damping: 25 }}
      className="rounded-md border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700"
    >
      {children}
    </motion.div>
  )
}