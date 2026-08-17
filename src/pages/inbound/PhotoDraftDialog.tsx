import { CheckCircle2, Loader2, Sparkles } from 'lucide-react'

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { requiresExpiry } from '@/lib/productSpecs'

export interface PhotoDraftItem {
  key: number
  product_id: number | null // null = 新商品，确认时自动建档
  brand: string | null
  model: string | null
  category: string
  quantity: number
  costYuan: string // 可编辑，元
  /** 该批次的到期日（保质期商品必填） */
  expiryDate: string
}

interface PhotoDraftDialogProps {
  draft: PhotoDraftItem[] | null
  onClose: () => void
  onPatchItem: (key: number, patch: Partial<PhotoDraftItem>) => void
  busy: boolean
  onConfirm: () => void
}

/** 拍送货单识别草稿 Dialog：人工逐行核对后确认入库 */
export function PhotoDraftDialog({ draft, onClose, onPatchItem, busy, onConfirm }: PhotoDraftDialogProps) {
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-brand-500" />
            送货单识别结果（{draft?.length ?? 0} 项）
          </DialogTitle>
          <DialogDescription>
            AI 识别可能有误，请逐行核对数量和进价。标「新商品」的确认时会自动建档（编号自动生成）。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-96 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>商品</TableHead>
                <TableHead>品类</TableHead>
                <TableHead className="w-24 text-right">数量</TableHead>
                <TableHead className="w-32 text-right">进价（元）</TableHead>
                <TableHead className="w-36">到期日</TableHead>
                <TableHead className="w-24">匹配</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {draft?.map((it) => {
                const needExpiry = requiresExpiry(it.category)
                return (
                  <TableRow key={it.key}>
                    <TableCell>
                      {[it.brand, it.model].filter(Boolean).join(' ') || (
                        <span className="text-muted-foreground">未识别名称</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{it.category}</TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        min={1}
                        value={it.quantity}
                        onChange={(e) =>
                          onPatchItem(it.key, { quantity: parseInt(e.target.value, 10) || 0 })
                        }
                        className="h-8 w-20 text-right"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={it.costYuan}
                        onChange={(e) => onPatchItem(it.key, { costYuan: e.target.value })}
                        placeholder="必填"
                        className="h-8 w-28 text-right"
                      />
                    </TableCell>
                    <TableCell>
                      {needExpiry ? (
                        <Input
                          type="date"
                          value={it.expiryDate}
                          onChange={(e) => onPatchItem(it.key, { expiryDate: e.target.value })}
                          className={`h-8 w-36 ${needExpiry && !it.expiryDate ? 'border-red-400 focus-visible:ring-red-400' : ''}`}
                        />
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {it.product_id ? (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                          已有商品
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                          新商品
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            {busy ? '入库中...' : `核对无误，确认入库 ${draft?.length ?? 0} 项`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
