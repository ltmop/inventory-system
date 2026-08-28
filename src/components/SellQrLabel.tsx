// 开单二维码贴纸：A4 网格排版（与价格标签同版式 3 列 × 8 行），
// 每个贴纸一个二维码，微信扫一扫直达该商品的开单页（数量/售价/收款在手机上完成）。
// 打印走 printArea('labels') + portal 打印副本，与价格标签同一套机制。
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import { Printer, TriangleAlert } from 'lucide-react'

import { formatPrice, productName } from '@/lib/formatters'
import { printArea } from '@/lib/print'
import { sellQrCodeOf, sellQrUrl } from '@/lib/sellQr'
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

export const QR_LABELS_PER_PAGE = 24

export interface QrLabelData {
  key: string
  name: string
  price: number
  code: string // 码内容的可读文字（条码或 SKU）
  qrDataUrl: string
}

/** 单个开单二维码贴纸（60×34mm，与价格标签同尺寸，混着贴也整齐） */
export function SellQrLabel({ label }: { label: QrLabelData }) {
  return (
    <div className="box-border flex h-[34mm] w-[60mm] overflow-hidden border-[0.2mm] border-dashed border-slate-400 bg-white p-[1.5mm] text-black">
      <img src={label.qrDataUrl} alt="" className="h-[30mm] w-[30mm] flex-none" />
      <div className="flex min-w-0 flex-1 flex-col pl-[1mm]">
        <div className="line-clamp-2 text-[9px] font-bold leading-tight">{label.name}</div>
        <div className="text-[15px] font-bold leading-tight">{formatPrice(label.price)}</div>
        <div className="mt-auto truncate font-mono text-[7px] text-slate-500">{label.code}</div>
        <div className="text-[7px] leading-tight text-slate-400">微信扫一扫直接开单</div>
      </div>
    </div>
  )
}

/** 整版贴纸：每 24 个一页 */
export function SellQrLabelSheet({ labels }: { labels: QrLabelData[] }) {
  const pages: QrLabelData[][] = []
  for (let i = 0; i < labels.length; i += QR_LABELS_PER_PAGE) {
    pages.push(labels.slice(i, i + QR_LABELS_PER_PAGE))
  }
  return (
    <div className="bg-white text-black">
      {pages.map((page, pi) => (
        <div
          key={pi}
          className="grid w-[186mm] grid-cols-3 gap-[1mm_3mm]"
          style={{ pageBreakAfter: pi < pages.length - 1 ? 'always' : 'auto' }}
        >
          {page.map((l) => (
            <SellQrLabel key={l.key} label={l} />
          ))}
        </div>
      ))}
    </div>
  )
}

interface SellQrLabelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  products: Product[]
  /** 手机看店地址（server:status 的 url）；null = 服务没开，贴纸打出来也扫不通 */
  serverUrl: string | null
}

/** 批量开单二维码贴纸：当前筛选出的商品每个 N 张 */
export function SellQrLabelDialog({ open, onOpenChange, products, serverUrl }: SellQrLabelDialogProps) {
  const [count, setCount] = useState(1)
  const [qrMap, setQrMap] = useState<Record<string, string>>({})

  // 换一批商品/地址时重新生成二维码（dataURL，生成失败留空该张贴纸跳过）
  useEffect(() => {
    if (!open || !serverUrl || products.length === 0) {
      setQrMap({})
      return
    }
    let cancelled = false
    const gen = async () => {
      const entries = await Promise.all(
        products.map(async (p) => {
          const code = sellQrCodeOf(p)
          try {
            const url = await QRCode.toDataURL(sellQrUrl(serverUrl, code), { width: 240, margin: 1 })
            return [String(p.id), url] as const
          } catch {
            return [String(p.id), ''] as const
          }
        }),
      )
      if (!cancelled) setQrMap(Object.fromEntries(entries))
    }
    void gen()
    return () => {
      cancelled = true
    }
  }, [open, serverUrl, products])

  const qty = Math.min(Math.max(Math.floor(count) || 1, 1), 12)
  const labels: QrLabelData[] = products.flatMap((p) => {
    const qr = qrMap[String(p.id)]
    if (!qr) return []
    const one: QrLabelData = {
      key: String(p.id),
      name: productName(p),
      price: p.suggest_price ?? p.cost_price,
      code: sellQrCodeOf(p),
      qrDataUrl: qr,
    }
    return Array.from({ length: qty }, (_, i) => ({ ...one, key: `${p.id}-${i}` }))
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>打印开单二维码贴纸</DialogTitle>
          <DialogDescription>
            贴在货架上，微信扫一扫直接进这个商品的开单页。A4 一张排 {QR_LABELS_PER_PAGE} 个，虚线是裁剪线。
          </DialogDescription>
        </DialogHeader>

        {!serverUrl ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <TriangleAlert className="mt-0.5 size-4 flex-none" />
            <span>
              「手机看店」服务没开，贴纸打出来也扫不通。请先到 设置 → 手机看店 打开开关，再回来打印。
            </span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Label htmlFor="qr-count">每个商品打几张</Label>
              <Input
                id="qr-count"
                type="number"
                min={1}
                max={12}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">
                {products.length} 个商品 × {qty} 张 = {products.length * qty} 个贴纸，约{' '}
                {Math.ceil((products.length * qty) / QR_LABELS_PER_PAGE)} 页
              </span>
            </div>
            {/* 屏幕预览：整版 A4 缩小看 */}
            <div className="max-h-[50vh] overflow-auto rounded-lg bg-slate-100 p-3">
              {labels.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">二维码生成中…</div>
              ) : (
                <div style={{ zoom: 0.5 } as React.CSSProperties}>
                  <SellQrLabelSheet labels={labels} />
                </div>
              )}
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button onClick={() => printArea('labels')} disabled={!serverUrl || labels.length === 0}>
            <Printer className="size-4" />
            打印
          </Button>
        </DialogFooter>
      </DialogContent>
      {/* 打印副本：portal 到 body，屏幕上看不到，打印时只显示它 */}
      {open && serverUrl && labels.length > 0 &&
        createPortal(
          <div className="print-area">
            <SellQrLabelSheet labels={labels} />
          </div>,
          document.body,
        )}
    </Dialog>
  )
}
