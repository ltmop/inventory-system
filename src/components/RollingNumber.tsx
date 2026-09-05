import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'

/** 数据变化时数字滚动（里程表感）。绑定真实业务字段；reduced-motion / 减弱动效时直接显示终值。 */
export function RollingNumber({
  value,
  className,
  format = (v: number) => Math.round(v).toLocaleString(),
}: {
  value: number
  className?: string
  format?: (v: number) => string
}) {
  const [opts, setOpts] = useState<{ key: number; text: string }>(() => ({ key: value, text: format(value) }))
  const reduced =
    typeof window !== 'undefined' &&
    (window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.classList.contains('ui-reduce'))

  useEffect(() => {
    if (value === opts.key) return
    // 动画带终值兜底：500ms 后强制落在终值
    setOpts({ key: value, text: format(value) })
    if (reduced) return
    const t = setTimeout(() => setOpts((s) => ({ ...s, key: value })), 520)
    return () => clearTimeout(t)
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  // 减弱动效：无滚动动画
  if (reduced) return <span className={className}>{opts.text}</span>

  return (
    <span
      key={opts.key}
      className={cn('rolling-num', className)}
      style={{ animation: 'roll-in .5s cubic-bezier(.2,.9,.3,1)' }}
    >
      {format(value)}
    </span>
  )
}
