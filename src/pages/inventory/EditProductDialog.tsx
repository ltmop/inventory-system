import { useEffect, useState } from 'react'
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
import { backend } from '@/lib/api'
import {
  deleteProductPhoto, pickCompressedPhoto, productPhotoUrl, uploadProductPhoto,
} from '@/lib/photo'
import {
  SPEC_LABELS, SPEC_PLACEHOLDERS, specFieldsFor, type SpecField,
} from '@/lib/productSpecs'
import { useAppStore } from '@/store/appStore'
import {
  CATEGORIES, PRICE_LEVELS, PRICE_LEVEL_LABELS,
  type Category, type PriceLevel, type Product, type ProductStatus, type Unit,
} from '@/types'
import { PRODUCT_STATUSES } from '@/types'

/** 编辑商品表单（元字符串；保存时页面统一转分） */
export interface EditProductForm {
  category: Category | ''
  sub_category: string
  brand: string
  model: string
  cost_price: string
  suggest_price: string
  location: string
  status: ProductStatus | ''
  min_stock: string // 安全库存：空串=不单独设，按默认 5 预警
  /** 计量单位（通用版）：由 units 表驱动，allow_decimal 支持小数 */
  unit: Unit | ''
}

interface EditProductDialogProps {
  editing: Product | null
  form: EditProductForm
  onFormChange: (updater: (f: EditProductForm) => EditProductForm) => void
  specForm: Record<SpecField, string>
  onSpecFormChange: (updater: (s: Record<SpecField, string>) => Record<SpecField, string>) => void
  tierForm: Record<PriceLevel, string>
  onTierFormChange: (updater: (s: Record<PriceLevel, string>) => Record<PriceLevel, string>) => void
  saving: boolean
  onSave: () => void
  onClose: () => void
}

/** 编辑商品 Dialog：SKU 创建后不可改 */
export function EditProductDialog({
  editing,
  form,
  onFormChange,
  specForm,
  onSpecFormChange,
  tierForm,
  onTierFormChange,
  saving,
  onSave,
  onClose,
}: EditProductDialogProps) {
  // 商品图片：选图即存（不跟表单一起等「保存」），photo_path 本地 state 跟弹窗走，
  // 因为 editing 是打开弹窗时的快照，store 刷新后它不会自己变
  const units = useAppStore((s) => s.units)
  const unitOptions = units.length > 0 ? units : [{ name: '件', allow_decimal: 0 }]
  const updateProduct = useAppStore((s) => s.updateProduct)
  const loadAll = useAppStore((s) => s.loadAll)
  const [photoPath, setPhotoPath] = useState<string | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null) // 刚选完图的本地 dataUrl（含 mock 路径仅预览）
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoError, setPhotoError] = useState('')

  // 换商品/开关弹窗时重置图片区
  useEffect(() => {
    setPhotoPath(editing?.photo_path ?? null)
    setPhotoPreview(null)
    setPhotoError('')
    setPhotoBusy(false)
  }, [editing?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const photoUrl = photoPreview ?? productPhotoUrl(photoPath, editing?.updated_at)

  const pickPhoto = async () => {
    if (!editing || photoBusy) return
    setPhotoBusy(true)
    setPhotoError('')
    try {
      const picked = await pickCompressedPhoto()
      if (!picked) return // 用户取消
      if (!backend) {
        setPhotoPreview(picked.dataUrl) // mock 路径：只本地预览不落盘，不报错
        return
      }
      const fileName = await uploadProductPhoto(editing.id, picked.base64)
      await updateProduct(editing.id, { photo_path: fileName })
      setPhotoPath(fileName)
      setPhotoPreview(picked.dataUrl) // fi-img 有缓存，先用本地 dataUrl 顶上下次打开再走协议
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : String(e))
    } finally {
      setPhotoBusy(false)
    }
  }

  const removePhoto = async () => {
    if (!editing || photoBusy) return
    setPhotoBusy(true)
    setPhotoError('')
    try {
      if (backend) {
        await deleteProductPhoto(editing.id) // 主进程删文件 + 清 photo_path
        await loadAll() // 同步 store（库存页缩略图跟着没）
      }
      setPhotoPath(null)
      setPhotoPreview(null)
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : String(e))
    } finally {
      setPhotoBusy(false)
    }
  }

  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑商品</DialogTitle>
          <DialogDescription>
            SKU <span className="font-mono">{editing?.sku_code}</span> 创建后不可修改
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          {/* 商品图片：选图即存，不跟表单一起等「保存」 */}
          <div className="col-span-2 space-y-2 border-b pb-3">
            <Label>商品图片</Label>
            <PhotoPicker
              previewUrl={photoUrl}
              busy={photoBusy}
              onPick={pickPhoto}
              onDelete={photoUrl ? removePhoto : null}
            />
            {photoError && <div className="text-xs text-red-600">{photoError}</div>}
          </div>
          <div className="space-y-2">
            <Label>品类 *</Label>
            <Select
              value={form.category}
              onValueChange={(v) => onFormChange((f) => ({ ...f, category: v as Category }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择品类" />
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
          <div className="space-y-2">
            <Label>子类</Label>
            <Input
              value={form.sub_category}
              onChange={(e) => onFormChange((f) => ({ ...f, sub_category: e.target.value }))}
              placeholder="如：手竿 / 纺车轮"
            />
          </div>
          <div className="space-y-2">
            <Label>品牌</Label>
            <Input
              value={form.brand}
              onChange={(e) => onFormChange((f) => ({ ...f, brand: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>型号规格</Label>
            <Input
              value={form.model}
              onChange={(e) => onFormChange((f) => ({ ...f, model: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>最近进价（元）*</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.cost_price}
              onChange={(e) => onFormChange((f) => ({ ...f, cost_price: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>建议售价（元）</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.suggest_price}
              onChange={(e) => onFormChange((f) => ({ ...f, suggest_price: e.target.value }))}
            />
            <div className="text-xs text-muted-foreground">这是默认价，卖货时先带出它</div>
          </div>
          <div className="space-y-2">
            <Label>货位</Label>
            <Input
              value={form.location}
              onChange={(e) => onFormChange((f) => ({ ...f, location: e.target.value }))}
            />
          </div>
          {/* 安全库存：消耗快的商品可调大；留空按默认 5 */}
          <div className="space-y-2">
            <Label>安全库存</Label>
            <Input
              type="number"
              min="0"
              step="1"
              value={form.min_stock}
              onChange={(e) => onFormChange((f) => ({ ...f, min_stock: e.target.value }))}
              placeholder="低于这个数就提醒你，默认 5"
            />
          </div>
          <div className="space-y-2">
            <Label>计量单位</Label>
            <Select
              value={form.unit}
              onValueChange={(v) => onFormChange((f) => ({ ...f, unit: v as Unit }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择计量单位" />
              </SelectTrigger>
              <SelectContent>
                {unitOptions.map((u) => (
                  <SelectItem key={u.name} value={u.name}>
                    {u.name}{u.allow_decimal ? '（可小数）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>状态 *</Label>
            <Select
              value={form.status}
              onValueChange={(v) => onFormChange((f) => ({ ...f, status: v as ProductStatus }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择状态" />
              </SelectTrigger>
              <SelectContent>
                {PRODUCT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* 价格档次：五档各一个价，空着=没设这档；卖货时在出库确认里一键带出 */}
          <div className="col-span-2 space-y-2 border-t pt-3">
            <div className="text-xs text-muted-foreground">
              价格档次（选填，单位：元；空着表示没设这档。卖货时点一下档位就自动带出价格）
            </div>
            <div className="grid grid-cols-3 gap-3 md:grid-cols-5">
              {PRICE_LEVELS.map((t) => (
                <div key={t} className="space-y-1">
                  <Label>{PRICE_LEVEL_LABELS[t]}价</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={tierForm[t]}
                    onChange={(e) =>
                      onTierFormChange((s) => ({ ...s, [t]: e.target.value }))
                    }
                    placeholder="没设"
                  />
                </div>
              ))}
            </div>
          </div>
          {/* 商品规格：颜色/材质/保质期，全部选填 */}
          {form.category && (
            <div className="col-span-2 space-y-2 border-t pt-3">
              <div className="text-xs text-muted-foreground">规格（选填，随品类变化）</div>
              <div className="grid grid-cols-3 gap-3">
                {specFieldsFor(form.category).map((f) => (
                  <div key={f} className="space-y-1">
                    <Label>{SPEC_LABELS[f]}</Label>
                    <Input
                      value={specForm[f]}
                      onChange={(e) =>
                        onSpecFormChange((s) => ({ ...s, [f]: e.target.value }))
                      }
                      placeholder={SPEC_PLACEHOLDERS[f]}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
