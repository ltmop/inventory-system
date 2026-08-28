import { Fish, ImagePlus, Loader2, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'

interface PhotoPickerProps {
  /** 当前展示地址（fi-img:// 或 data: 预览），null=还没图 */
  previewUrl: string | null
  busy: boolean
  onPick: () => void
  /** 传了才显示「删除」（一般有图时才传） */
  onDelete?: (() => void) | null
}

/** 商品图片区：有图显示预览+「换一张」「删除」，无图显示「选一张图片」（编辑/新建商品弹窗共用） */
export function PhotoPicker({ previewUrl, busy, onPick, onDelete }: PhotoPickerProps) {
  return (
    <div className="flex items-center gap-4">
      {previewUrl ? (
        <img
          src={previewUrl}
          alt="商品图片"
          className="size-24 rounded-md border object-cover"
        />
      ) : (
        <div className="flex size-24 items-center justify-center rounded-md border border-dashed bg-slate-50 text-slate-300">
          <Fish className="size-10" />
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onPick} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
          {previewUrl ? '换一张' : '选一张图片'}
        </Button>
        {previewUrl && onDelete && (
          <Button type="button" variant="ghost" size="sm" onClick={onDelete} disabled={busy}>
            <Trash2 className="size-4 text-red-500" />
            删除
          </Button>
        )}
        <div className="text-xs text-muted-foreground">存本机，最长边压到 800px</div>
      </div>
    </div>
  )
}
