import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { productName } from '@/lib/formatters'
import type { Product } from '@/types'

interface DeleteProductDialogProps {
  deleting: Product | null
  onCancel: () => void
  onConfirm: () => void
}

/** 删除确认 Dialog（危险操作二次确认） */
export function DeleteProductDialog({ deleting, onCancel, onConfirm }: DeleteProductDialogProps) {
  return (
    <Dialog open={deleting !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除商品</DialogTitle>
          <DialogDescription>
            确定要删掉「{deleting ? productName(deleting) : ''}」（{deleting?.sku_code}
            ）吗？删掉就找不回来了。如果这个商品有过入库/出库记录，系统会拦着不让删
            ——只是以后不卖了的话，建议改成「停产」，记录都还在。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
