import { motion } from 'motion/react'
import type { ReactNode } from 'react'

/** 鱼形空状态插画 + 人话提示：数据为空时用，替代干巴巴的"暂无数据" */
export function EmptyState({
  title,
  desc,
  action,
  compact,
}: {
  title: string
  desc?: string
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-6' : 'py-14'}`}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative mb-4"
      >
        {/* 鱼形插画：简笔线条鱼 + 水波 */}
        <svg width="72" height="56" viewBox="0 0 72 56" fill="none" className="text-lake-400">
          {/* 水波 */}
          <path d="M6 44 Q14 40 22 44 Q30 48 38 44 Q46 40 54 44 Q62 48 66 44" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4" fill="none" />
          <path d="M14 50 Q22 47 30 50 Q38 53 46 50 Q54 47 60 50" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.25" fill="none" />
          {/* 鱼身 */}
          <path d="M18 22 Q28 10 44 14 Q58 18 58 28 Q58 38 44 42 Q28 46 18 34 Q12 30 18 22Z" fill="currentColor" opacity="0.18" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          {/* 鱼眼 */}
          <circle cx="46" cy="24" r="2.2" fill="currentColor" />
          {/* 鱼尾 */}
          <path d="M58 28 L68 22 L68 34 Z" fill="currentColor" opacity="0.35" />
          {/* 鱼鳍 */}
          <path d="M36 12 Q40 6 46 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          {/* 气泡 */}
          <circle cx="14" cy="20" r="2" fill="currentColor" opacity="0.4" />
          <circle cx="9" cy="14" r="1.3" fill="currentColor" opacity="0.3" />
        </svg>
      </motion.div>
      <div className="text-sm font-medium text-slate-600 dark:text-slate-300">{title}</div>
      {desc && <div className="mt-1 text-xs text-muted-foreground max-w-xs">{desc}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
