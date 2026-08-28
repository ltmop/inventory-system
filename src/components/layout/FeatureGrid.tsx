// 通用功能卡片网格（通用版 UI）：小功能卡片用 1px 灰色细边框，白色卡片，点击跳转。
import { Link } from 'react-router-dom'
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
        <div className="mb-4">
          <h2 className="text-lg font-bold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="group rounded-lg border border-slate-200 bg-white p-4 transition-all hover:border-blue-400 hover:shadow-sm"
          >
            <div className="flex items-start justify-between">
              <div className="flex size-10 items-center justify-center rounded-md bg-blue-50 text-blue-600">
                <item.icon className="size-5.5" />
              </div>
              {item.isNew && (
                <span className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">新</span>
              )}
              {item.badge != null && item.badge > 0 && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-600">
                  {item.badge}
                </span>
              )}
            </div>
            <div className="mt-3 text-base font-bold text-slate-900">{item.label}</div>
            <div className="mt-1 text-[13px] leading-relaxed text-slate-500">{item.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}

/** 页面头部：黑色大标题 + 副标题 */
export function PageHeading({ title, desc, icon: Icon }: { title: string; desc?: string; icon?: LucideIcon }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      {Icon && (
        <div className="flex size-11 items-center justify-center rounded-lg bg-blue-600 text-white">
          <Icon className="size-6" />
        </div>
      )}
      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900">{title}</h1>
        {desc && <p className="mt-0.5 text-sm text-slate-500">{desc}</p>}
      </div>
    </div>
  )
}
