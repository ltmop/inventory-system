import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowRight,
  ClipboardCheck,
  LayoutDashboard,
  PackageMinus,
  PackageSearch,
  ScanBarcode,
  Search,
  PackagePlus,
  Truck,
  Factory,
  Users,
  Boxes,
  TriangleAlert,
  Layers,
  Tags,
  Scale,
  BarChart3,
  Wallet,
  ReceiptText,
  FileClock,
  Sparkles,
  FileUp,
  BookOpen,
  Settings,
  Home,
  KeyRound,
} from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import {
  searchCommands,
  searchProducts,
  type CommandItem,
  type ProductMatch,
} from '@/lib/commandSearch'
import { productName } from '@/lib/formatters'
import { cn } from '@/lib/utils'

// 命令图标与侧边栏保持一致，店主看着眼熟
const COMMAND_ICONS: Record<string, typeof ScanBarcode> = {
  'go-dashboard': Home,
  'go-inbound-hub': PackagePlus,
  'go-inbound': ScanBarcode,
  'go-purchase': Truck,
  'go-suppliers': Factory,
  'go-sales-hub': PackageMinus,
  'go-outbound': PackageMinus,
  'go-customers': Users,
  'go-stock-hub': PackageSearch,
  'go-inventory': Boxes,
  'go-stock-take': ClipboardCheck,
  'go-waste': TriangleAlert,
  'go-kits': Layers,
  'go-categories': Tags,
  'go-units': Scale,
  'go-mine-hub': LayoutDashboard,
  'go-reports': BarChart3,
  'go-receipt': ReceiptText,
  'go-expenses': Wallet,
  'go-audit': FileClock,
  'go-account': KeyRound,
  'go-ai-hub': Sparkles,
  'go-import': FileUp,
  'go-knowledge': BookOpen,
  'go-settings': Settings,
}

const MATCH_FIELD_LABEL: Record<ProductMatch['matchedField'], string> = {
  sku: 'SKU',
  barcode: '条码',
  brand: '品牌',
  model: '型号',
  category: '品类',
}

type Entry = { kind: 'command'; command: CommandItem } | { kind: 'product'; match: ProductMatch }

/**
 * Ctrl+K 全局命令面板：搜商品直达库存页，或跳转到常用功能。
 * 手写实现（不引入 cmdk），动画用项目已有的 motion。
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const products = useAppStore((s) => s.products)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 全局快捷键：Ctrl/Cmd+K 开关面板（在输入框里也生效，方便随时唤起）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 顶栏「搜索/快捷跳转」按钮触发：全局事件打开面板
  useEffect(() => {
    const openPalette = () => setOpen(true)
    window.addEventListener('open-command-palette', openPalette)
    return () => window.removeEventListener('open-command-palette', openPalette)
  }, [])

  // 每次打开都重置搜索词并聚焦输入框
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const commands = useMemo(() => searchCommands(query), [query])
  const matched = useMemo(() => searchProducts(products, query), [products, query])

  // 扁平选项列表：功能命令在前，商品在后，上下键统一移动
  const entries = useMemo<Entry[]>(
    () => [
      ...commands.map((command) => ({ kind: 'command', command }) as Entry),
      ...matched.map((match) => ({ kind: 'product', match }) as Entry),
    ],
    [commands, matched],
  )
  // 搜索词变化导致列表变短时，高亮位置跟着钳回来
  const activeIdx = Math.min(active, Math.max(entries.length - 1, 0))

  // 高亮项保持在可视区域内
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, entries])

  const run = (entry: Entry) => {
    setOpen(false)
    if (entry.kind === 'command') {
      navigate(entry.command.path)
    } else {
      // 跳到库存页并用 SKU 做关键词定位（库存页消费 ?q= 参数）
      navigate(`/inventory?q=${encodeURIComponent(entry.match.product.sku_code)}`)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, entries.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = entries[activeIdx]
      if (entry) run(entry)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={() => setOpen(false)}
        >
          <motion.div
            role="dialog"
            aria-label="全局搜索"
            className="w-full max-w-lg overflow-hidden rounded-xl border bg-background shadow-2xl"
            initial={{ opacity: 0, scale: 0.96, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -6 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={onKeyDown}
                placeholder="搜商品（品牌/型号/SKU/条码），或输入功能名…"
                className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                Esc
              </kbd>
            </div>

            <div ref={listRef} className="max-h-80 overflow-y-auto p-2">
              {entries.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  没找到和「{query}」相关的商品或功能，换个词试试
                </div>
              ) : (
                (() => {
                  let idx = -1
                  const itemClass = (i: number) =>
                    cn(
                      'flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm',
                      i === activeIdx ? 'bg-accent text-accent-foreground' : 'text-foreground',
                    )
                  return (
                    <>
                      {commands.length > 0 && (
                        <div>
                          <div className="px-3 pb-1 pt-2 text-xs text-muted-foreground">
                            功能直达
                          </div>
                          {commands.map((c) => {
                            idx++
                            const i = idx
                            const Icon = COMMAND_ICONS[c.id] ?? ArrowRight
                            return (
                              <button
                                key={c.id}
                                data-active={i === activeIdx}
                                className={itemClass(i)}
                                onMouseEnter={() => setActive(i)}
                                onClick={() => run({ kind: 'command', command: c })}
                              >
                                <Icon className="size-4 shrink-0 text-muted-foreground" />
                                {c.label}
                              </button>
                            )
                          })}
                        </div>
                      )}
                      {matched.length > 0 && (
                        <div>
                          <div className="px-3 pb-1 pt-2 text-xs text-muted-foreground">
                            商品（回车跳到库存页）
                          </div>
                          {matched.map((m) => {
                            idx++
                            const i = idx
                            return (
                              <button
                                key={m.product.id}
                                data-active={i === activeIdx}
                                className={itemClass(i)}
                                onMouseEnter={() => setActive(i)}
                                onClick={() => run({ kind: 'product', match: m })}
                              >
                                <PackageSearch className="size-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate">
                                  {productName(m.product)}
                                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                                    {m.product.sku_code}
                                  </span>
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {MATCH_FIELD_LABEL[m.matchedField]} · 库存{' '}
                                  {totalStockOf(m.product.id)}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )
                })()
              )}
            </div>

            <div className="flex gap-4 border-t px-3 py-2 text-xs text-muted-foreground">
              <span>↑↓ 选择</span>
              <span>回车 打开</span>
              <span>Esc 关闭</span>
              <span className="ml-auto">Ctrl+K 随时唤起</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
