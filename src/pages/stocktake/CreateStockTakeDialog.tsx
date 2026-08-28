import { CircleCheck } from 'lucide-react'

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
import { CATEGORIES, type Supplier } from '@/types'

interface CreateStockTakeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  area: string
  onAreaChange: (v: string) => void
  category: string
  onCategoryChange: (v: string) => void
  supplierKey: string
  onSupplierKeyChange: (v: string) => void
  operator: string
  onOperatorChange: (v: string) => void
  /** 盘点方式：batch=按批次逐行 / sku=按商品合并盘总数 */
  mode: 'batch' | 'sku'
  onModeChange: (v: 'batch' | 'sku') => void
  areas: string[]
  suppliers: Supplier[]
  wholeShopValue: string
  submitting: boolean
  onSubmit: () => void
}

/** 新建盘点 Dialog：选好范围后按当前批次库存生成盘点明细 */
export function CreateStockTakeDialog({
  open,
  onOpenChange,
  area,
  onAreaChange,
  category,
  onCategoryChange,
  supplierKey,
  onSupplierKeyChange,
  operator,
  onOperatorChange,
  mode,
  onModeChange,
  areas,
  suppliers,
  wholeShopValue,
  submitting,
  onSubmit,
}: CreateStockTakeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建盘点</DialogTitle>
          <DialogDescription>
            选好范围（区域/品类/供应商可以组合）后，系统按当前批次库存生成盘点明细
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>盘点区域</Label>
            <Select value={area} onValueChange={onAreaChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={wholeShopValue}>全店</SelectItem>
                {areas.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>品类</Label>
            <Select value={category} onValueChange={onCategoryChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={wholeShopValue}>全部品类</SelectItem>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>供应商</Label>
            <Select value={supplierKey} onValueChange={onSupplierKeyChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={wholeShopValue}>全部供应商</SelectItem>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>操作人</Label>
            <Input value={operator} onChange={(e) => onOperatorChange(e.target.value)} />
          </div>
          <div className="col-span-2 space-y-1">
            <Label>盘点方式</Label>
            <Select value={mode} onValueChange={(v) => onModeChange(v as 'batch' | 'sku')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="batch">按批次逐行（同商品多批拆开分别点）</SelectItem>
                <SelectItem value="sku">按商品盘总数（货架分不清批次时用这个）</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {mode === 'sku'
                ? '按商品只填"一共多少个"，系统自动把差异按各批次数量比例分摊'
                : '每个批次单独填实盘数，精确到批次'}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            <CircleCheck className="size-4" />
            {submitting ? '创建中...' : '创建并开始盘点'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
