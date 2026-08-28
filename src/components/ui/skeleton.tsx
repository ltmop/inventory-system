import { cn } from '@/lib/utils'

/** 骨架屏：数据加载时的 shimmer 占位，替代"加载中..."。水面波光感 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-gradient-to-r from-slate-200/70 via-slate-100 to-slate-200/70 dark:from-slate-700/50 dark:via-slate-600/50 dark:to-slate-700/50',
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
