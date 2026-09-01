// MetricStrip（Direction A·数据看板感）：二级页顶部一条「今日指标」，一进来先看数字，再点进去操作。
export interface Metric {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'accent' | 'positive' | 'warning' | 'danger'
}

const TONE: Record<NonNullable<Metric['tone']>, string> = {
  default: 'text-slate-900 dark:text-white',
  accent: 'text-brand-600',
  positive: 'text-emerald-600',
  warning: 'text-amber-600',
  danger: 'text-red-600',
}

export function MetricStrip({ metrics, className }: { metrics: Metric[]; className?: string }) {
  return (
    <div className={`mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 ${className ?? ''}`}>
      {metrics.map((m) => (
        <div key={m.label} className="min-w-0 rounded-xl border border-slate-200 bg-white px-4 py-3.5">
          <div className="truncate text-xs font-medium text-slate-500">{m.label}</div>
          <div className={`mt-1 truncate text-xl font-bold tabular-nums tracking-tight ${TONE[m.tone ?? 'default']}`}>{m.value}</div>
          {m.sub && <div className="mt-0.5 truncate text-xs text-slate-400">{m.sub}</div>}
        </div>
      ))}
    </div>
  )
}
