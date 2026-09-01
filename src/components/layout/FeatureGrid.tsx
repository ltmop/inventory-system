// 通用功能卡片网格（通用版 UI）：小功能卡片用 1px 灰色细边框，白色卡片，点击跳转。
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface FeatureItem {
  to: string
  label: string
  desc: string
  icon: LucideIcon
  /** 可选角标（数字/提示） */
  badge?: number
  /** 是否新功能标记 */
  isNew?: boolean
}

export function FeatureGrid({
  items,
  title,
  subtitle,
  className,
}: {
  items: FeatureItem[]
  title?: string
  subtitle?: string
  className?: string
}) {
  return (
    <div className={className}>
      {title && (
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <div>
            <h2 className="text-base font-bold tracking-tight text-slate-900 dark:text-white">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="group flex flex-col rounded-xl border border-slate-200 bg-white p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-blue-400/70 hover:shadow-md"
          >
            <div className="flex items-start justify-between">
              <div className="flex size-10 items-center justify-center rounded-lg bg-blue-50/80 text-blue-600 transition-colors group-hover:bg-blue-600/10">
                <item.icon className="size-5" />
              </div>
              {item.isNew && (
                <span className="rounded-md bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">新</span>
              )}
              {item.badge != null && item.badge > 0 && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-600">
                  {item.badge}
                </span>
              )}
            </div>
            <div className="mt-3 text-[15px] font-bold text-slate-900">{item.label}</div>
            <div className="mt-1 text-[13px] leading-relaxed text-slate-500">{item.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}

/** 页面头部（Direction A 统一）：大标题 + 副标题 + 可选主行动槽 */
export function PageHeading({ title, desc, icon: Icon, action }: { title: string; desc?: string; icon?: LucideIcon; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {Icon && (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
            <Icon className="size-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{title}</h1>
          {desc && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{desc}</p>}
        </div>
      </div>
      {action}
    </div>
  )
}
