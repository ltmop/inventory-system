import * as React from 'react'
import { ScanBarcode, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface ScanHeroProps {
  value: string
  onChange: (v: string) => void
  /** 回车或点击搜索按钮触发 */
  onSubmit: () => void
  placeholder: string
  /** 输入框下方的小字提示，如"USB 扫码枪扫描后自动输入并回车" */
  hint?: string
  inputRef?: React.Ref<HTMLInputElement>
  autoFocus?: boolean
  /** 左侧图标，默认扫码枪图标 */
  icon?: 'scan' | 'search'
  /** 追加在输入行内部（如搜索候选下拉） */
  children?: React.ReactNode
  /** 输入框右侧搜索按钮左边的附加操作（如语音按钮） */
  action?: React.ReactNode
}

/**
 * 扫码/搜索英雄区 —— 全站使用频率最高的交互点。
 * 入库、出库两页共用，非聚焦态也要有"舞台感"：浅蓝渐变底 + 品牌色描边；
 * 聚焦态整卡浮起并带品牌色光晕。
 */
export function ScanHero({
  value,
  onChange,
  onSubmit,
  placeholder,
  hint,
  inputRef,
  autoFocus,
  icon = 'scan',
  children,
  action,
}: ScanHeroProps) {
  const Icon = icon === 'scan' ? ScanBarcode : Search
  return (
    <div
      className={cn(
        'rounded-2xl border border-brand-200/70 bg-gradient-to-br from-white via-white to-brand-50/80',
        'shadow-card transition-all duration-200',
        'focus-within:-translate-y-0.5 focus-within:border-brand-500 focus-within:shadow-focus',
      )}
    >
      <div className="relative px-6 pt-5 pb-4">
        <div className="relative">
          <Icon className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2 text-brand-500" />
          <Input
            ref={inputRef}
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
            placeholder={placeholder}
            className="h-14 rounded-xl border-slate-200 bg-white pl-13 pr-14 text-base shadow-inner placeholder:text-slate-400 focus-visible:border-brand-400 focus-visible:ring-brand-500/20"
          />
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {action}
            <button
              onClick={onSubmit}
              title="搜索"
              className="cursor-pointer rounded-lg bg-brand-500 p-2 text-white shadow-sm transition-colors hover:bg-brand-600"
            >
              <Search className="size-5" />
            </button>
          </div>
        </div>
        {children}
      </div>
      {hint && (
        <div className="rounded-b-2xl border-t border-brand-100/80 bg-brand-50/50 px-6 py-2.5 text-xs text-brand-700/70">
          {hint}
        </div>
      )}
    </div>
  )
}
