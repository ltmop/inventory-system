import { create } from 'zustand'
import { AnimatePresence, motion } from 'motion/react'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

const DURATION: Record<ToastKind, number> = { success: 2600, error: 4200, info: 3000 }

const useToastStore = create<{
  items: ToastItem[]
  push: (t: ToastItem) => void
  remove: (id: number) => void
}>((set) => ({
  items: [],
  push: (t) => set((s) => ({ items: [...s.items, t] })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}))

let seq = 0

function show(kind: ToastKind, message: string, duration?: number) {
  const id = ++seq
  useToastStore.getState().push({ id, kind, message })
  window.setTimeout(() => useToastStore.getState().remove(id), duration ?? DURATION[kind])
}

/** 全局 toast：操作成功后轻量浮层反馈，自动消失，不推挤页面布局 */
export const toast = {
  success: (m: string, d?: number) => show('success', m, d),
  error: (m: string, d?: number) => show('error', m, d),
  info: (m: string, d?: number) => show('info', m, d),
}

const KIND_STYLE: Record<ToastKind, { icon: typeof CircleCheck; ring: string; iconColor: string }> = {
  success: { icon: CircleCheck, ring: 'border-emerald-200 dark:border-emerald-500/30', iconColor: 'text-emerald-500' },
  error: { icon: CircleAlert, ring: 'border-red-200 dark:border-red-500/30', iconColor: 'text-red-500' },
  info: { icon: Info, ring: 'border-sky-200 dark:border-sky-500/30', iconColor: 'text-sky-500' },
}

/** 全局浮层宿主：挂在 App 根，顶部居中堆叠 */
export function Toaster() {
  const items = useToastStore((s) => s.items)
  const remove = useToastStore((s) => s.remove)

  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[70] flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2 px-3">
      <AnimatePresence>
        {items.map((t) => {
          const { icon: Icon, ring, iconColor } = KIND_STYLE[t.kind]
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: -16, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              className={`pointer-events-auto flex w-full items-center gap-2.5 rounded-lg border bg-white px-4 py-3 text-sm shadow-lg dark:bg-slate-800 ${ring}`}
            >
              <Icon className={`size-4 shrink-0 ${iconColor}`} />
              <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-200">{t.message}</span>
              <button
                onClick={() => remove(t.id)}
                className="shrink-0 text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-300"
                title="关闭"
              >
                <X className="size-4" />
              </button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
