import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PhotoPicker } from '@/components/PhotoPicker'
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
import { pickCompressedPhoto } from '@/lib/photo'
import {
  SPEC_LABELS, SPEC_PLACEHOLDERS, specFieldsFor, type SpecField,
} from '@/lib/productSpecs'
import { CATEGORIES, UNITS, type Category, type Unit } from '@/types'

// 品牌预选列表（通用消费品品牌），"自定义"选项触发自由输入
const BRAND_PRESETS = [
  '__custom__', '怡客', '洁宁', '力邦', '优创', '得力', '舒肤佳', '维达',
  '雕牌', '蓝月亮', '海尔', '美的', '小米', '南孚', '晨光',
  '齐心', '威露士', '立白', '公牛', '奥妙',
]

/** 新建商品表单（元字符串；提交时页面统一转分） */
export interface NewProductForm {
  category: Category
  subCategory: string
  brand: string
  brandCustom: string
  model: string
  costYuan: string
  suggestYuan: string
  location: string
  minStock: string // 安全库存：空串=不单独设，按默认 5 预警
  /** 计量单位（v2.2）：件=整数按个卖（默认）；米=鱼线按长度小数卖 */
  unit: Unit
  specs: Record<SpecField, string>
  /** 商品图片预览（压缩后的 dataUrl）：商品还没建档没有 id，先挂表单上，建档成功拿到 id 再落盘 */
  photoDataUrl: string | null
}

interface NewProductDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  barcode: string
  form: NewProductForm
  onFormChange: (patch: Partial<NewProductForm>) => void
  submitting: boolean
  onSubmit: () => void
}

/** 新建商品 Dialog：条码自动关联，SKU 由后端（或 mock 路径）自动生成 */
export function NewProductDialog({
  open,
  onOpenChange,
  barcode,
  form,
  onFormChange,
  submitting,
  onSubmit,
}: NewProductDialogProps) {
  // 选图压缩中的本地忙态（不落盘，纯表单预览，建档后由页面统一保存）
  const [photoBusy, setPhotoBusy] = useState(false)
  const pickPhoto = async () => {
    if (photoBusy) return
    setPhotoBusy(true)
    try {
      const picked = await pickCompressedPhoto()
      if (picked) onFormChange({ photoDataUrl: picked.dataUrl })
    } finally {
      setPhotoBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建商品</DialogTitle>
          <DialogDescription>条码 {barcode || '-'} 将自动关联到新商品</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          {/* 商品图片：先选着，建档成功拿到 id 后自动落盘 */}
          <div className="col-span-2 space-y-2 border-b pb-3">
            <Label>商品图片</Label>
            <PhotoPicker
              previewUrl={form.photoDataUrl}
              busy={photoBusy}
              onPick={pickPhoto}
              onDelete={form.photoDataUrl ? () => onFormChange({ photoDataUrl: null }) : null}
            />
          </div>
          <div className="space-y-1">
            <Label>品类 *</Label>
            <Select value={form.category} onValueChange={(v) => onFormChange({ category: v as Category })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>子类</Label>
            <Input
              value={form.subCategory}
              onChange={(e) => onFormChange({ subCategory: e.target.value })}
              placeholder="如：手竿、PE线、伊势尼..."
            />
          </div>
          <div className="space-y-1">
            <Label>品牌</Label>
            <Select value={form.brand} onValueChange={(v) => onFormChange({ brand: v })}>
              <SelectTrigger>
                <SelectValue placeholder="选择品牌..." />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {BRAND_PRESETS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b === '__custom__' ? '+ 自定义品牌' : b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.brand === '__custom__' && (
              <Input
                className="mt-1"
                value={form.brandCustom}
                onChange={(e) => onFormChange({ brandCustom: e.target.value })}
                placeholder="输入自定义品牌名"
              />
            )}
          </div>
          <div className="space-y-1">
            <Label>型号/规格</Label>
            <Input value={form.model} onChange={(e) => onFormChange({ model: e.target.value })} placeholder="如：3.6m 28调" />
          </div>
          <div className="space-y-1">
            <Label>进价（元）*</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.costYuan}
              onChange={(e) => onFormChange({ costYuan: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label>建议售价（元）</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={form.suggestYuan}
              onChange={(e) => onFormChange({ suggestYuan: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label>货位</Label>
            <Input value={form.location} onChange={(e) => onFormChange({ location: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>安全库存</Label>
            <Input
              type="number"
              min="0"
              step="1"
              value={form.minStock}
              onChange={(e) => onFormChange({ minStock: e.target.value })}
              placeholder="低于这个数就提醒你，默认 5"
            />
          </div>
          <div className="space-y-1">
            <Label>计量单位</Label>
            <Select value={form.unit} onValueChange={(v) => onFormChange({ unit: v as Unit })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {u === '件' ? '件（按个/包整数卖）' : '米（按长度小数卖，如布匹/线材）'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* 渔具规格：按品类出不同字段，全部选填，不填也能入库 */}
          <div className="col-span-2 space-y-2 border-t pt-3">
            <div className="text-xs text-muted-foreground">
              规格（选填，随品类变化，如味型/备注可写进颜色或型号里）
            </div>
            <div className="grid grid-cols-3 gap-3">
              {specFieldsFor(form.category).map((f) => (
                <div key={f} className="space-y-1">
                  <Label>{SPEC_LABELS[f]}</Label>
                  <Input
                    value={form.specs[f]}
                    onChange={(e) =>
                      onFormChange({ specs: { ...form.specs, [f]: e.target.value } })
                    }
                    placeholder={SPEC_PLACEHOLDERS[f]}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {submitting ? '创建中...' : '创建并入库'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
