// 低库存提醒：开机自动弹一次；关掉之后可从仪表盘「低库存」卡片随时重开
// 只在数据加载完成后由 Layout 挂载；本次启动内只自动弹一次
import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { TriangleAlert } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { productName } from '@/lib/formatters'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const LOW_STOCK_THRESHOLD = 5

export function LowStockAlert() {
  const products = useAppStore((s) => s.products)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const open = useAppStore((s) => s.lowStockAlertOpen)
  const setOpen = useAppStore((s) => s.setLowStockAlertOpen)
  const shown = useAppStore((s) => s.lowStockAlertShown)
  const navigate = useNavigate()

  const lowItems = useMemo(
    () =>
      products
        .filter((p) => p.status !== '停产')
        .map((p) => ({ p, total: totalStockOf(p.id) }))
        .filter((x) => x.total < (x.p.min_stock ?? LOW_STOCK_THRESHOLD))
        .sort((a, b) => a.total - b.total),
    [products, totalStockOf],
  )

  // 低库存提醒：每天只自动弹一次（localStorage 记日期，当天不再打扰），
  // 之后可随时从仪表盘「低库存」卡片手动重开
  useEffect(() => {
    if (shown || lowItems.length === 0) return
    const today = new Date().toISOString().slice(0, 10)
    try {
      if (window.localStorage.getItem('fi-lowstock-alert-date') === today) {
        useAppStore.setState({ lowStockAlertShown: true })
        return
      }
    } catch { /* ignore */ }
    useAppStore.setState({ lowStockAlertOpen: true, lowStockAlertShown: true })
    try {
      window.localStorage.setItem('fi-lowstock-alert-date', today)
    } catch { /* ignore */ }
  }, [shown, lowItems.length])

  if (lowItems.length === 0) return null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        {/* 内容区滑入：Dialog 打开时整体从下往上浮入，列表项依次入场 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 28 }}
          className="grid gap-4"
        >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-red-500" />
            有 {lowItems.length} 个商品库存偏低
          </DialogTitle>
          <DialogDescription>
            以下商品库存低于各自预警线（未单独设置的按 {LOW_STOCK_THRESHOLD} 件算），建议今天安排补货，别等卖断了才发现
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-64 space-y-1 overflow-auto rounded-md border p-2">
          {lowItems.map(({ p, total }, i) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.12 + i * 0.05, duration: 0.25, ease: 'easeOut' }}
              className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-slate-50"
            >
              <div>
                <span className="font-medium text-slate-800">{productName(p)}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{p.sku_code}</span>
              </div>
              <span className={total === 0 ? 'font-bold text-red-600' : 'font-medium text-amber-600'}>
                {total === 0 ? '已断货' : `剩 ${total} 件`}
              </span>
            </motion.div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            知道了
          </Button>
          <Button
            onClick={() => {
              setOpen(false)
              navigate('/inbound')
            }}
          >
            去入库补货
          </Button>
        </DialogFooter>
        </motion.div>
      </DialogContent>
    </Dialog>
  )
}
