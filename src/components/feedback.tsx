import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { CircleCheck } from 'lucide-react'

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
    <div className="flex items-start justify-between">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">{title}</h1>
        <p className="mt-1 text-[13px] text-slate-500">{subtitle}</p>
      </div>
      {action}
    </div>
  )
}

/** 操作成功反馈：弹簧打勾动画，替代静态文字 */
export function SuccessBanner({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-4 py-2.5 text-sm font-medium text-green-700"
    >
      <motion.span
        initial={{ scale: 0, rotate: -30 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 15, delay: 0.05 }}
      >
        <CircleCheck className="size-4" />
      </motion.span>
      {children}
    </motion.div>
  )
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
