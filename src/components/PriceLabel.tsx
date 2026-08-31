// 价格标签预览 + 打印对话框：A4 网格排版（3 列 × 8 行 = 一张 24 个标签）。
// 条码是 CODE128-B，纯 JS 画在 canvas 上（见 lib/barcode.ts），零依赖。
// 打印副本与小票同理：createPortal 到 body 的 .print-area，@media print 只显示它。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Printer } from 'lucide-react'
import { drawCode128B } from '@/lib/barcode'
import { formatPrice, productName } from '@/lib/formatters'
import { formatSpecs } from '@/lib/productSpecs'
import { printArea } from '@/lib/print'
import type { Product } from '@/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** 一张 A4 排 3 列 × 8 行 = 24 个标签（每个约 60×34mm，虚线框方便裁剪） */
export const LABELS_PER_PAGE = 24

export interface LabelData {
  name: string // 商品名（品牌+型号；型号缺了就拿规格顶上）
  price: number // 售价，单位：分
  code: string // 条码内容：有条码用条码，没用 SKU
}

/** 从商品生成标签数据：价格用建议售价，没设就退回最近进价 */
export function labelFromProduct(p: Product): LabelData {
  const base = productName(p)
  // 型号为空时 productName 可能只剩品牌或 SKU，把规格拼上去才不显得空
  const spec = p.model ? '' : formatSpecs(p)
  return {
    name: [base, spec].filter(Boolean).join(' '),
    price: p.suggest_price ?? p.cost_price,
    code: p.barcode ?? p.sku_code,
  }
}

/** CODE128-B 条码 canvas：按 2 倍分辨率画再 CSS 缩一半，打印更锐利 */
function Barcode({ code }: { code: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    if (!ref.current) return
    try {
      setSize(drawCode128B(ref.current, code, { height: 56, moduleWidth: 2 }))
    } catch {
      setSize(null) // 含中文等不支持的字符：条码画不出，下面还有文字码兜底
    }
  }, [code])
  return (
    <canvas
      ref={ref}
      style={size ? { width: size.width / 2, height: size.height / 2 } : undefined}
    />
  )
}

export function PriceLabel({ label }: { label: LabelData }) {
  return (
    <div
      className="box-border flex h-[34mm] w-[60mm] flex-col overflow-hidden border-[0.2mm] border-dashed border-slate-400 bg-white px-[2mm] py-[1mm] text-black"
    >
      <div className="truncate text-[10px] font-bold leading-tight">{label.name}</div>
      <div className="flex items-baseline justify-between">
        <span className="text-[18px] font-bold leading-none">{formatPrice(label.price)}</span>
        <span className="text-[8px] text-slate-500">AI 智能进销存系统</span>
      </div>
      <div className="mt-auto flex flex-col items-center">
        <Barcode code={label.code} />
        <div className="font-mono text-[8px] leading-none">{label.code}</div>
      </div>
    </div>
  )
}

/** 整版标签：每 24 个一页，页间分页 */
export function PriceLabelSheet({ labels }: { labels: LabelData[] }) {
  const pages: LabelData[][] = []
  for (let i = 0; i < labels.length; i += LABELS_PER_PAGE) {
    pages.push(labels.slice(i, i + LABELS_PER_PAGE))
  }
  return (
    <div className="bg-white text-black">
      {pages.map((page, pi) => (
        <div
          key={pi}
          className="grid w-[186mm] grid-cols-3 gap-[1mm_3mm]"
          style={{ pageBreakAfter: pi < pages.length - 1 ? 'always' : 'auto' }}
        >
          {page.map((l, i) => (
            <PriceLabel key={i} label={l} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function PriceLabelDialog({
  product,
  open,
  onOpenChange,
}: {
  product: Product | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [count, setCount] = useState(8)

  // 换商品时恢复默认打 8 张
  useEffect(() => {
    if (product) setCount(8)
  }, [product])

  const qty = Math.min(Math.max(Math.floor(count) || 1, 1), 96)
  const labels = product ? Array<LabelData>(qty).fill(labelFromProduct(product)) : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>打印价格标签</DialogTitle>
          <DialogDescription>
            {product ? productName(product) : ''}
            ：A4 纸一张能排 24 个，虚线是裁剪线。点「打印」弹出系统打印窗口，也能先「另存为
            PDF」。
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3">
          <Label htmlFor="label-count">打几张</Label>
          <Input
            id="label-count"
            type="number"
            min={1}
            max={96}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">
            一张 A4 排 {LABELS_PER_PAGE} 个，{qty} 张要打 {Math.ceil(qty / LABELS_PER_PAGE)} 页
          </span>
        </div>
        {/* 屏幕预览：整版 A4 缩小看，打印副本不带缩放 */}
        <div className="max-h-[50vh] overflow-auto rounded-lg bg-slate-100 p-3">
          <div style={{ zoom: 0.5 } as React.CSSProperties}>{product && <PriceLabelSheet labels={labels} />}</div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button onClick={() => printArea('labels')} disabled={!product}>
            <Printer className="size-4" />
            打印
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* 打印副本：portal 到 body，屏幕上看不到，打印时只显示它 */}
      {open && product &&
        createPortal(
          <div className="print-area">
            <PriceLabelSheet labels={labels} />
          </div>,
          document.body,
        )}
    </Dialog>
  )
}
