// 小票预览 + 打印对话框：58mm 热敏小票风格（等宽字体、虚线分隔）。
// 预览在 Dialog 里；打印副本用 createPortal 挂到 body 的 .print-area，
// 打印时 @media print 只显示它（见 index.css 和 lib/print.ts）。
import { createPortal } from 'react-dom'
import { Printer } from 'lucide-react'
import { formatPrice } from '@/lib/formatters'
import { printArea } from '@/lib/print'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface ReceiptItem {
  name: string
  quantity: number
  unitPrice: number // 单价，单位：分
  /** 计量单位（通用版）：件/斤/米等，小票数量后面带上 */
  unit?: string
}

export interface ReceiptData {
  receiptNo: string
  time: string // ISO 时间
  operator: string
  items: ReceiptItem[]
  paid: number | null // 实收（分）；null = 全额收款（散客或客户全额付清）
  customerName: string | null
}

/** 小票单号：XP + 流水时间戳（YYYYMMDDHHmmss），一眼能看出是哪一刻卖的 */
export function makeReceiptNo(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `XP${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

function fmtReceiptTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const Dash = () => <div className="my-[1mm] border-t border-dashed border-black" />

/** 58mm 小票本体：预览和打印复用的是同一个组件，保证所见即所打 */
export function Receipt({ data }: { data: ReceiptData }) {
  const total = data.items.reduce((s, it) => s + it.quantity * it.unitPrice, 0)
  const paid = data.paid ?? total
  const change = Math.max(paid - total, 0)
  const owed = Math.max(total - paid, 0)
  return (
    <div className="w-[58mm] bg-white px-[2mm] py-[3mm] font-mono text-[10px] leading-snug text-black">
      <div className="text-center text-[13px] font-bold">AI 智能进销存</div>
      <Dash />
      <div>单号：{data.receiptNo}</div>
      <div>时间：{fmtReceiptTime(data.time)}</div>
      <div>店员：{data.operator}</div>
      <Dash />
      {data.items.map((it, i) => (
        <div key={i} className="mb-[0.5mm]">
          <div className="break-all">{it.name}</div>
          <div className="flex justify-between">
            <span>
              {it.quantity}{it.unit && it.unit !== '件' ? it.unit : ''} × {formatPrice(it.unitPrice)}
            </span>
            <span>{formatPrice(it.quantity * it.unitPrice)}</span>
          </div>
        </div>
      ))}
      <Dash />
      <div className="flex justify-between text-[12px] font-bold">
        <span>应收合计</span>
        <span>{formatPrice(total)}</span>
      </div>
      <div className="flex justify-between">
        <span>实收</span>
        <span>{formatPrice(paid)}</span>
      </div>
      {change > 0 && (
        <div className="flex justify-between">
          <span>找零</span>
          <span>{formatPrice(change)}</span>
        </div>
      )}
      {owed > 0 && (
        <div className="mt-[0.5mm] font-bold">
          欠款 {formatPrice(owed)}
          {data.customerName ? `（${data.customerName}）` : ''}
        </div>
      )}
      <Dash />
      <div className="text-center">谢谢惠顾</div>
    </div>
  )
}

export function ReceiptDialog({
  data,
  open,
  onOpenChange,
}: {
  data: ReceiptData | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>打印小票</DialogTitle>
          <DialogDescription>
            核对一下内容，点「打印」会弹出系统打印窗口；没接打印机也能先选「另存为
            PDF」存下来。以后买了 58mm 热敏小票机直接选它就能打。
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[55vh] justify-center overflow-auto rounded-lg bg-slate-100 py-4">
          {data && <Receipt data={data} />}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button onClick={() => printArea('receipt')} disabled={!data}>
            <Printer className="size-4" />
            打印
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* 打印副本：portal 到 body，屏幕上看不到，打印时只显示它 */}
      {open && data &&
        createPortal(
          <div className="print-area">
            <Receipt data={data} />
          </div>,
          document.body,
        )}
    </Dialog>
  )
}
