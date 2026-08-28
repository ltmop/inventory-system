import { motion } from 'motion/react'
import { Loader2, Trash2 } from 'lucide-react'

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatPrice, productName } from '@/lib/formatters'
import type { Product, Supplier } from '@/types'

// 元字符串转分，非法输入返回 null
function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

// 新建订单的商品行草稿
export interface DraftItem {
  key: number
  product: Product
  quantity: string
  costYuan: string
}

interface CreateOrderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  suppliers: Supplier[]
  supplierId: string
  onSupplierIdChange: (v: string) => void
  noSupplierValue: string
  notes: string
  onNotesChange: (v: string) => void
  pickerKw: string
  onPickerKwChange: (v: string) => void
  pickerCandidates: Product[]
  onAddDraftItem: (p: Product) => void
  draftItems: DraftItem[]
  onPatchDraft: (key: number, patch: Partial<DraftItem>) => void
  onRemoveDraft: (key: number) => void
  lastCostOf: (productId: number) => number | null
  draftTotal: number
  error: string
  busy: boolean
  onSubmit: () => void
}

/** 新建采购单 Dialog：选供应商、搜索加货、提交订货单 */
export function CreateOrderDialog({
  open,
  onOpenChange,
  suppliers,
  supplierId,
  onSupplierIdChange,
  noSupplierValue,
  notes,
  onNotesChange,
  pickerKw,
  onPickerKwChange,
  pickerCandidates,
  onAddDraftItem,
  draftItems,
  onPatchDraft,
  onRemoveDraft,
  lastCostOf,
  draftTotal,
  error,
  busy,
  onSubmit,
}: CreateOrderDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>新建采购单</DialogTitle>
          <DialogDescription>
            选供应商、加要订的货，提交后货到了到列表里点「收货入库」
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>供应商 *</Label>
              <Select value={supplierId} onValueChange={onSupplierIdChange}>
                <SelectTrigger>
                  <SelectValue placeholder="选择供应商..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={noSupplierValue} disabled>
                    选择供应商...
                  </SelectItem>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>备注</Label>
              <Input
                value={notes}
                onChange={(e) => onNotesChange(e.target.value)}
                placeholder="比如：月底结账、急用先发货"
              />
            </div>
          </div>

          {/* 加商品：搜索下拉点选 */}
          <div className="relative space-y-1">
            <Label>加商品</Label>
            <Input
              value={pickerKw}
              onChange={(e) => onPickerKwChange(e.target.value)}
              placeholder="输入 SKU/品牌/型号搜索，点一下加进单子..."
            />
            {pickerKw.trim() && (
              <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-white shadow-card-hover">
                {pickerCandidates.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onAddDraftItem(p)}
                    className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-sm transition-colors hover:bg-brand-50"
                  >
                    <span>
                      {productName(p)}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {p.sku_code}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      最近进价 {formatPrice(lastCostOf(p.id))}
                    </span>
                  </button>
                ))}
                {pickerCandidates.length === 0 && (
                  <div className="px-4 py-3 text-sm text-muted-foreground">没有匹配的商品</div>
                )}
              </div>
            )}
          </div>

          {/* 已加的商品行 */}
          {draftItems.length > 0 && (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>商品</TableHead>
                    <TableHead className="w-24 text-right">数量</TableHead>
                    <TableHead className="w-32 text-right">进价（元）</TableHead>
                    <TableHead className="w-28 text-right">小计</TableHead>
                    <TableHead className="w-14" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draftItems.map((d) => {
                    const qty = Number(d.quantity)
                    const cost = yuanToCents(d.costYuan)
                    const sub =
                      Number.isInteger(qty) && qty > 0 && cost !== null ? qty * cost : null
                    return (
                      <TableRow key={d.key}>
                        <TableCell>
                          {productName(d.product)}
                          <span className="ml-2 font-mono text-xs text-muted-foreground">
                            {d.product.sku_code}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            min={1}
                            value={d.quantity}
                            onChange={(e) => onPatchDraft(d.key, { quantity: e.target.value })}
                            className="h-8 w-20 text-right"
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={d.costYuan}
                            onChange={(e) => onPatchDraft(d.key, { costYuan: e.target.value })}
                            className="h-8 w-28 text-right"
                          />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {sub !== null ? formatPrice(sub) : '-'}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            title="删掉这行"
                            onClick={() => onRemoveDraft(d.key)}
                          >
                            <Trash2 className="size-4 text-red-500" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              <div className="flex justify-end border-t bg-slate-50 px-4 py-2.5 text-sm">
                合计：<span className="ml-1 text-base font-bold text-brand-600 tabular-nums">{formatPrice(draftTotal)}</span>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button asChild onClick={onSubmit} disabled={busy}>
            <motion.button whileTap={{ scale: 0.96 }}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? '提交中...' : '提交订货单'}
            </motion.button>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
