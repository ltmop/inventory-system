// P1-3 语音开单确认卡（铁律：确认前不落库）
// - 商品/数量/单价逐项可改；unmatched（含 LLM 越界）标红，必须从候选里手选
// - 整单实收金额与收款方式可改；赊账=实收 0 + 结算时选客户（confirmCheckout 口径）
// - 展示计费：LLM 段消耗 X token / 余额剩 Y；纯本地命中显示"未消耗额度"
import { useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { PaymentMethod, Product } from '@/types'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export interface VoiceOrderItem {
  productId: number | null
  name: string
  qty: number
  matchedBy: 'local' | 'llm' | 'unmatched' | 'pending'
  candidates: Array<{ id: number; name: string; score: number }>
}
export interface VoiceOrderResult {
  ok: true
  degraded: boolean
  failReason?: string | null
  items: VoiceOrderItem[]
  totalAmount: number | null
  payMethod: string | null
  credit: boolean
  billing?: { usage: { total_tokens?: number }; remaining?: number } | null
  text?: string
}
export interface VoiceOrderLine {
  product: Product
  quantity: number
  priceCents: number
}
export interface VoiceOrderPay {
  paidYuan: string
  payMethod: PaymentMethod | null
  credit: boolean
}

const productName = (p: Product) => [p.brand, p.model].filter(Boolean).join(' ') || p.sku_code

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: VoiceOrderResult | null
  products: Product[]
  onConfirm: (lines: VoiceOrderLine[], pay: VoiceOrderPay) => void
}

export function VoiceOrderConfirmCard({ open, onOpenChange, draft, products, onConfirm }: Props) {
  // 行内编辑状态：只存覆盖值（qty/priceYuan/productId 都是可选覆盖）
  type RowEdit = Partial<{ productId: number | null; qty: string; priceYuan: string }>
  const [edits, setEdits] = useState<Record<number, RowEdit>>({})
  const [paidYuan, setPaidYuan] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('现金')
  const [credit, setCredit] = useState(false)

  // draft 变化时重置编辑态（用 open 触发初始化）
  const rows = useMemo(() => {
    if (!draft) return []
    return draft.items.map((it, idx) => {
      const e = edits[idx]
      const product = products.find((p) => p.id === (e?.productId ?? it.productId)) ?? null
      return {
        idx,
        raw: it,
        product,
        qty: e?.qty ?? String(it.qty),
        priceYuan: e?.priceYuan ?? (product?.suggest_price != null ? (product.suggest_price / 100).toFixed(2) : ''),
      }
    })
  }, [draft, edits, products])

  const initFrom = (d: VoiceOrderResult | null) => {
    setEdits({})
    setPaidYuan(d?.totalAmount != null ? String(d.totalAmount) : '')
    setMethod((d?.payMethod as PaymentMethod) || '现金')
    setCredit(!!d?.credit)
  }

  const setEdit = (idx: number, patch: RowEdit) =>
    setEdits((prev) => ({ ...prev, [idx]: { ...prev[idx], ...patch } }))

  const unresolved = rows.filter((r) => !r.product)
  const totalCents = rows.reduce((s, r) => {
    const price = Math.round(Number(r.priceYuan) * 100)
    const qty = Number(r.qty)
    return s + (Number.isFinite(price) && Number.isFinite(qty) ? price * qty : 0)
  }, 0)

  const handleConfirm = () => {
    const lines: VoiceOrderLine[] = []
    for (const r of rows) {
      if (!r.product) return // 有未解决行不允许确认（按钮已禁用，双保险）
      const qty = Number(r.qty)
      const priceCents = Math.round(Number(r.priceYuan) * 100)
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(priceCents) || priceCents <= 0) return
      lines.push({ product: r.product, quantity: qty, priceCents })
    }
    onConfirm(lines, { paidYuan: credit ? '0' : paidYuan, payMethod: credit ? null : method, credit })
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) initFrom(draft)
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>语音开单 · 请核对</DialogTitle>
          <DialogDescription>
            {draft?.text ? `识别原文：“${draft.text}”。` : ''}逐项核对，确认后才记账。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-2 overflow-y-auto">
          {rows.map((r) => (
            <div
              key={r.idx}
              className={`rounded-lg border px-3 py-2 ${r.product ? 'border-slate-200' : 'border-red-300 bg-red-50'}`}
            >
              {!r.product && (
                <div className="mb-1 flex items-center gap-1 text-xs text-red-600">
                  <AlertTriangle className="size-3.5" />
                  “{r.raw.name}”未识别，请手动选择商品
                </div>
              )}
              <div className="flex items-center gap-2">
                {r.product ? (
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
                    {productName(r.product)}
                    {r.raw.matchedBy === 'llm' && <span className="ml-1 text-xs text-brand-500">(AI 匹配)</span>}
                  </span>
                ) : (
                  <Select
                    value=""
                    onValueChange={(v) => setEdit(r.idx, { productId: Number(v) })}
                  >
                    <SelectTrigger className="h-8 flex-1 text-xs">
                      <SelectValue placeholder="选择商品…" />
                    </SelectTrigger>
                    <SelectContent>
                      {(r.raw.candidates.length > 0
                        ? r.raw.candidates.map((c) => products.find((p) => p.id === c.id)).filter(Boolean)
                        : products.slice(0, 50)
                      ).map((p) => (
                        <SelectItem key={(p as Product).id} value={String((p as Product).id)}>
                          {productName(p as Product)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Input
                  className="h-8 w-16 text-center text-sm"
                  value={r.qty}
                  onChange={(e) => setEdit(r.idx, { qty: e.target.value })}
                  title="数量"
                />
                <span className="text-xs text-slate-400">×</span>
                <Input
                  className="h-8 w-20 text-center text-sm"
                  value={r.priceYuan}
                  onChange={(e) => setEdit(r.idx, { priceYuan: e.target.value })}
                  title="单价（元）"
                  placeholder="单价"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2 border-t pt-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600">合计</span>
            <span className="font-bold text-slate-800">¥{(totalCents / 100).toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-sm text-slate-600">
              <input type="checkbox" checked={credit} onChange={(e) => setCredit(e.target.checked)} />
              赊账（结算时选客户）
            </label>
            {!credit && (
              <>
                <Input
                  className="h-8 w-24 text-sm"
                  value={paidYuan}
                  onChange={(e) => setPaidYuan(e.target.value)}
                  placeholder="实收金额"
                />
                <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                  <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(['现金', '微信', '支付宝', '其他'] as const).map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>
          {/* 计费透明：LLM 段才消耗额度 */}
          <div className="text-xs text-slate-400">
            {draft?.billing?.usage
              ? `本次 AI 理解消耗 ${draft.billing.usage.total_tokens ?? 0} token${draft.billing.remaining != null ? `，余额剩 ${draft.billing.remaining}` : ''}`
              : '本地匹配命中，未消耗 AI 额度'}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={unresolved.length > 0 || rows.length === 0} onClick={handleConfirm}>
            确认开单（{rows.length} 项）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
