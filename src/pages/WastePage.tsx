import { useEffect, useState } from 'react'
import { PackageX, Plus, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { backend } from '@/lib/api'
import { formatPrice, formatDateTime, productName } from '@/lib/formatters'
import { validateQty, unitOf, isDecimalUnit } from '@/lib/quantity'
import { PageHeader, ErrorBanner, SuccessBanner } from '@/components/feedback'
import { GuestBlockCard } from '@/components/GuestBlockCard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/EmptyState'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface WasteLog {
  id: number
  product_id: number
  quantity: number
  reason: string
  operator: string | null
  created_at: string
  sku_code: string
  brand: string | null
  model: string | null
  cost_price: number
}

interface WasteSummary {
  totalQty: number
  totalCost: number
  items: { product_id: number; sku_code: string; brand: string | null; model: string | null; cost_price: number; total_qty: number; total_cost: number }[]
}

/** 报损登记：破损 / 临期报废 / 过期，从库存扣减并计入损耗成本 */
export function WastePage() {
  const products = useAppStore((s) => s.products)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const createWaste = useAppStore((s) => s.createWaste)

  const [keyword, setKeyword] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [reason, setReason] = useState('')
  const [logs, setLogs] = useState<WasteLog[]>([])
  const [summary, setSummary] = useState<WasteSummary | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadData = () => {
    if (!backend) return
    backend.invoke('waste:list', { limit: 100 }).then((r) => r && setLogs(r)).catch(() => {})
    backend.invoke('waste:summary').then((r) => r && setSummary(r)).catch(() => {})
  }
  useEffect(loadData, [])

  const filtered = keyword.trim()
    ? products.filter((p) => [p.sku_code, p.brand, p.model, p.barcode].filter(Boolean).join(' ').toLowerCase().includes(keyword.trim().toLowerCase()))
    : []

  const selected = products.find((p) => p.id === selectedId)

  const handleSubmit = async () => {
    if (!selected || submitting) return
    const qty = validateQty(Number(quantity), unitOf(selected))
    if (qty === null) {
      setError(isDecimalUnit(selected) ? '报损数量要大于 0，且最多 1 位小数' : '报损数量必须是 ≥1 的整数')
      return
    }
    if (!reason.trim()) { setError('填一下报损原因（如：活饵死亡/临期报废/破损）'); return }
    setSubmitting(true)
    setError('')
    try {
      await createWaste(selected.id, qty, reason.trim(), '店长')
      setSuccess(`已报损：${productName(selected)} × ${qty}（${reason.trim()}）`)
      setQuantity('1')
      setReason('')
      setSelectedId(null)
      setKeyword('')
      loadData()
    } catch (e) {
      setError(`报损失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <GuestBlockCard title="报损" />
<PageHeader title="报损登记" subtitle="破损、临期报废、过期——从库存扣减并计入损耗成本" />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* 损耗汇总 */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <div className="rounded-full bg-red-100 p-2.5"><PackageX className="size-5 text-red-600" /></div>
            <div>
              <div className="text-xs text-slate-500">累计损耗件数</div>
              <div className="text-2xl font-bold text-slate-800">{summary?.totalQty ?? 0} 件</div>
            </div>
          </CardContent>
        </Card>
        <Card className="py-4">
          <CardContent className="flex items-center gap-3">
            <div className="rounded-full bg-amber-100 p-2.5"><Trash2 className="size-5 text-amber-600" /></div>
            <div>
              <div className="text-xs text-slate-500">累计损耗成本</div>
              <div className="text-2xl font-bold text-red-600">{formatPrice(summary?.totalCost ?? 0)}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 报损表单 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="size-5 text-brand-500" />
            登记报损
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>搜索要报损的商品</Label>
            <Input
              value={keyword}
              onChange={(e) => { setKeyword(e.target.value); setSelectedId(null) }}
              placeholder="输入商品名 / SKU / 条码..."
              className="mt-1"
            />
            {keyword && !selected && filtered.length > 0 && (
              <div className="mt-2 max-h-48 overflow-auto rounded-md border">
                {filtered.slice(0, 10).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { setSelectedId(p.id); setKeyword(productName(p)) }}
                    className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer"
                  >
                    <span>{productName(p)}</span>
                    <span className="text-xs text-slate-400">库存 {totalStockOf(p.id)} {unitOf(p)} · {p.sku_code}</span>
                  </button>
                ))}
              </div>
            )}
            {keyword && !selected && filtered.length === 0 && (
              <p className="mt-2 text-xs text-slate-400">没找到商品</p>
            )}
          </div>
          {selected && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>报损数量 *（{unitOf(selected)}）</Label>
                <Input
                  type="number"
                  min={isDecimalUnit(selected) ? 0.1 : 1}
                  step={isDecimalUnit(selected) ? 0.1 : 1}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
                <p className="text-xs text-slate-400">当前库存 {totalStockOf(selected.id)} {unitOf(selected)}</p>
              </div>
              <div className="space-y-1">
                <Label>报损原因 *</Label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：活饵死亡 / 临期报废 / 破损" />
              </div>
            </div>
          )}
          {selected && (
            <Button onClick={handleSubmit} disabled={submitting} className="bg-red-600 hover:bg-red-700">
              <PackageX className="size-4" />
              {submitting ? '报损中...' : `确认报损 ${productName(selected)}`}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* 报损记录 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">报损记录</CardTitle>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <EmptyState compact title="还没有报损记录" desc="商品破损/临期报废时在这里登记，损耗就进成本了" />
          ) : (
            <div className="max-h-[480px] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>商品</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                    <TableHead className="text-right">成本</TableHead>
                    <TableHead>原因</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(w.created_at)}</TableCell>
                      <TableCell>
                        <span>{[w.brand, w.model].filter(Boolean).join(' ') || w.sku_code}</span>
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{w.sku_code}</span>
                      </TableCell>
                      <TableCell className="text-right text-red-600">-{w.quantity}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPrice(w.quantity * w.cost_price)}</TableCell>
                      <TableCell className="text-xs text-slate-500">{w.reason || '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
