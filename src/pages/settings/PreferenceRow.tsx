import type { ReactNode } from 'react'

/** 偏好设置行：标题 + 说明 + 右侧开关（整行可点） */
export function PreferenceRow({
  icon,
  title,
  description,
  checked,
  onToggle,
}: {
  icon: ReactNode
  title: string
  description: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-slate-50"
    >
      {icon}
      <span className="flex-1">
        <span className="block text-sm font-medium text-slate-800">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <span
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-brand-600' : 'bg-slate-300'
        }`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${
            checked ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  )
}
