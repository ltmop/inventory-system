// 全局 AI 浮层（M2-2）：任何业务页右下角悬浮球，点开即问 AI（问/拍/说复用 AiPanel）。
// AI 是能力不是页面——从 /ai-hub 独立导航降级为全局随手可用。
// 首页（/）已有显眼 AI 卡（M2-1），浮球只在业务页显示，避免同页两套 AI 面板。
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import { Sparkles, X } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { backend } from '@/lib/api'
import { AiPanel } from './AiPanel'

// 路由 → 页面上下文标签（让 AI 知道老板在哪页）
const CONTEXT_LABEL: Record<string, string> = {
  '/': '首页',
  '/inbound-hub': '入库',
  '/inbound': '进货入库',
  '/sales-hub': '销售',
  '/outbound': '开单',
  '/stock-hub': '库存',
  '/inventory': '库存',
  '/stock-take': '盘点',
  '/reports': '报表',
  '/purchase': '采购',
  '/suppliers': '供应商',
  '/customers': '客户',
  '/expenses': '支出',
  '/waste': '报损',
  '/kits': '套装',
  '/mine-hub': '我的',
  '/account': '账号',
  '/settings': '设置',
}

export function AiFloat() {
  const open = useAppStore((s) => s.aiFloatOpen)
  const setOpen = useAppStore((s) => s.setAiFloatOpen)
  const setContext = useAppStore((s) => s.setAiContext)
  const location = useLocation()
  const path = location.pathname
  const onHome = path === '/' || path === ''
  const ctxLabel = CONTEXT_LABEL[path] ?? null

  // 路由变化时记录当前页上下文到 store（AI 知道你在哪页）
  useEffect(() => {
    setContext(ctxLabel)
  }, [path, ctxLabel, setContext])

  // ESC 收起
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  // 首页由内联 AI 卡承担（M2-1），不重复挂浮球
  if (onHome) return null

  return (
    <>
      <motion.button
        type="button"
        onClick={() => setOpen(!open)}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
        title="AI 助手（问 / 说 / 拍）"
        aria-label="打开 AI 助手"
        className="fixed bottom-5 right-5 z-50 flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-brand-600 to-brand-400 text-white shadow-lg shadow-slate-900/20 hover:shadow-xl"
      >
        <Sparkles className="size-6" />
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            className="fixed bottom-20 right-4 z-50 w-[min(94vw,440px)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2">
              <Sparkles className="size-4 text-brand-500" />
              <span className="text-sm font-semibold text-slate-800">AI 助手</span>
              {ctxLabel && (
                <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-600">
                  当前在·{ctxLabel}
                </span>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="收起"
                aria-label="收起"
                className="ml-auto rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="max-h-[min(70vh,560px)] overflow-y-auto p-3">
              {backend ? <AiPanel /> : <p className="text-sm text-slate-500">AI 助手需要在桌面版中使用（当前为浏览器预览）。</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
