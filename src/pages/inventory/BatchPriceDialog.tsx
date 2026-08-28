import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

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
import { cn } from '@/lib/utils'
import type { BatchPriceMode } from '@/store/appStore'

interface BatchPriceDialogProps {
  open: boolean
  /** 涉及的商品数（确认话术里要用） */
  count: number
  busy: boolean
  onClose: () => void
  onConfirm: (mode: BatchPriceMode) => void
}

/**
 * 批量改价 Dialog：先选「统一打 X 折」或「统一改为 ¥X」，
 * 再进确认页把影响用大白话说清楚（改完不能一键撤回）。
 */
export function BatchPriceDialog({ open, count, busy, onClose, onConfirm }: BatchPriceDialogProps) {
  const [kind, setKind] = useState<'ratio' | 'fixed'>('ratio')
  const [ratioInput, setRatioInput] = useState('9') // 打几折：9 = ×0.9
  const [fixedInput, setFixedInput] = useState('') // 元
  const [error, setError] = useState('')
  // 两步走：edit 填数 → confirm 大白话确认
  const [step, setStep] = useState<'edit' | 'confirm'>('edit')

  // 每次打开重置回第一步
  useEffect(() => {
    if (open) {
      setKind('ratio')
      setRatioInput('9')
      setFixedInput('')
      setError('')
      setStep('edit')
    }
  }, [open])

  // 解析当前输入为 priceMode；不合法返回 null 并在 error 里说明
  const parse = (): BatchPriceMode | null => {
    if (kind === 'ratio') {
      const zhe = parseFloat(ratioInput)
      if (!Number.isFinite(zhe) || zhe <= 0) {
        setError('折扣要填大于 0 的数，比如 9 表示 9 折、8.5 表示 85 折')
        return null
      }
      return { kind: 'ratio', ratio: zhe / 10 }
    }
    const fen = Math.round(parseFloat(fixedInput) * 100)
    if (!Number.isFinite(fen) || fen <= 0) {
      setError('价格要填大于 0 的数（单位：元），比如 35 或 35.50')
      return null
    }
    return { kind: 'fixed', priceFen: fen }
  }

  const goConfirm = () => {
    const mode = parse()
    if (!mode) return
    setError('')
    setStep('confirm')
  }

  // 确认页的大白话影响说明
  const confirmText = (() => {
    const mode = parse()
    if (!mode) return ''
    return mode.kind === 'ratio'
      ? `这会把 ${count} 个商品的建议售价和已经设好的各档价格都打 ${ratioInput} 折（价格 × ${(mode.ratio).toFixed(2)}），改完不能一键撤回。确定要改吗？`
      : `这会把 ${count} 个商品的建议售价和已经设好的各档价格都改成 ¥${(mode.priceFen / 100).toFixed(2)}，改完不能一键撤回。确定要改吗？`
  })()

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        {step === 'edit' ? (
          <>
            <DialogHeader>
              <DialogTitle>批量改价（{count} 个商品）</DialogTitle>
              <DialogDescription>
                建议售价和已经设好的各档价格会一起改；没设过的档次不会新增。成本价（进价）不受影响。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setKind('ratio')}
                  className={cn(
                    'cursor-pointer rounded-md border-2 px-3 py-2 text-sm font-medium',
                    kind === 'ratio' ? 'border-brand-500 bg-brand-50' : 'border-slate-200',
                  )}
                >
                  统一打 X 折
                </button>
                <button
                  type="button"
                  onClick={() => setKind('fixed')}
                  className={cn(
                    'cursor-pointer rounded-md border-2 px-3 py-2 text-sm font-medium',
                    kind === 'fixed' ? 'border-brand-500 bg-brand-50' : 'border-slate-200',
                  )}
                >
                  统一改为 ¥X
                </button>
              </div>
              {kind === 'ratio' ? (
                <div className="space-y-2">
                  <Label htmlFor="batch-ratio">打几折（如 9 表示 9 折，8.5 表示 85 折）</Label>
                  <Input
                    id="batch-ratio"
                    type="number"
                    min="0"
                    step="0.1"
                    value={ratioInput}
                    onChange={(e) => setRatioInput(e.target.value)}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="batch-fixed">统一改成多少元（如 35 或 35.50）</Label>
                  <Input
                    id="batch-fixed"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="输入价格（元）"
                    value={fixedInput}
                    onChange={(e) => setFixedInput(e.target.value)}
                  />
                </div>
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button onClick={goConfirm}>下一步</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>确认批量改价</DialogTitle>
              <DialogDescription>{confirmText}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('edit')} disabled={busy}>
                返回修改
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  const mode = parse()
                  if (mode) onConfirm(mode)
                }}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}
                确认修改
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
