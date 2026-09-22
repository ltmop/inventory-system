import { useMemo, useState } from 'react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { productName } from '@/lib/formatters'
import { useAppStore } from '@/store/appStore'
import type { Category, Unit } from '@/types'

import { BrandField } from './BrandField'

/**
 * 批量建「一族规格」（2026-09-22 老板要求：录入即规范）。
 *
 * 老板原话：「一个品牌的产品，规格很多，但却要每一个都录入，而且还得拍照，规格命名格式不同一…
 *   假设一个品牌是：狼王，下面是子类：有鱼钩，鱼线，鱼竿等等，然后又分规格…
 *   现在这样的反而效率慢了，名字不统一。」
 *
 * 做法：品牌/品类/单位/进价售价 **填一次**，把规格名**粘一列**进来 → 一次建出 N 个商品。
 *   · 名字不再靠人手打：显示名统一由 `productName()`（品牌 + 规格）产出，与全站同一口径；
 *   · **建之前先查重**：与库里已有的（同品牌+同品类+同规格）以及本次列表内部重复都会标出来，
 *     已存在的一律跳过 —— 这是从源头堵住"同一条规格建了两遍"（库里已经查出 14 组）。
 *   · 每行可以带数量（`规格, 12`），带了的顺手记一笔入库，库存与「已盘点」一起到位。
 *
 * ⚠️ 不新增任何 IPC 通道：只用已有的 product:create / inbound:create（经 store 的 addProduct/addInbound）。
 *    新增通道会让装过的旧壳不认（2026-09-21 踩过一次），这里刻意避开。
 */
interface ParsedRow {
  /** 原文（规格名，已去首尾空白） */
  spec: string
  /** 数量：0 表示这行只建档不入库 */
  qty: number
  /** 原始行号（报错时指位置） */
  line: number
}

function parseLines(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line) return
    // 支持：制表符（Excel 粘贴）/ 半角逗号 / 全角逗号 / 空格+数字
    const parts = line.split(/[\t,，]/).map((s) => s.trim()).filter(Boolean)
    const spec = parts[0] || ''
    const qty = parts[1] ? Number(parts[1]) : 0
    out.push({ spec, qty: Number.isFinite(qty) && qty > 0 ? qty : 0, line: i + 1 })
  })
  return out
}

const keyOf = (brand: string, category: string, spec: string) =>
  (brand.trim() + '|' + category + '|' + spec.trim()).replace(/\s+/g, '').toLowerCase()

export function BatchSpecDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 建完通知外面（刷新列表/提示） */
  onDone?: (created: number) => void
}) {
  const products = useAppStore((s) => s.products)
  const categories = useAppStore((s) => s.categories)
  const units = useAppStore((s) => s.units)
  const addProduct = useAppStore((s) => s.addProduct)
  const addInbound = useAppStore((s) => s.addInbound)

  const [brand, setBrand] = useState('')
  const [category, setCategory] = useState<Category | ''>('')
  const [unit, setUnit] = useState<Unit>('件')
  const [costYuan, setCostYuan] = useState('')
  const [suggestYuan, setSuggestYuan] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<{ ok: string[]; skip: string[]; fail: string[] } | null>(null)

  const rows = useMemo(() => parseLines(text), [text])
  const costFen = Math.round((parseFloat(costYuan) || 0) * 100)
  const suggestFen = suggestYuan ? Math.round((parseFloat(suggestYuan) || 0) * 100) : null

  // 查重：库里已有的 + 本次列表内部重复（都按 品牌+品类+规格 归一后比）
  const existing = useMemo(() => {
    const s = new Set<string>()
    for (const p of products) s.add(keyOf(p.brand || '', p.category, p.model || ''))
    return s
  }, [products])

  const preview = useMemo(() => {
    const seen = new Set<string>()
    return rows.map((r) => {
      const k = keyOf(brand, category, r.spec)
      let note = ''
      if (!brand.trim()) note = '先填品牌'
      else if (!category) note = '先选品类'
      else if (existing.has(k)) note = '库里已有，将跳过'
      else if (seen.has(k)) note = '本列表内重复，将跳过'
      seen.add(k)
      const display = brand.trim()
        ? productName({ brand: brand.trim(), model: r.spec, sku_code: '' })
        : r.spec
      return { ...r, note, skip: note.includes('跳过'), display }
    })
  }, [rows, brand, category, existing])

  const willCreate = preview.filter((r) => !r.skip).length

  const submit = async () => {
    if (!brand.trim() || !category || busy) return
    setBusy(true)
    setResult(null)
    const ok: string[] = []
    const skip: string[] = []
    const fail: string[] = []
    let done = 0
    for (const r of preview) {
      if (r.skip) {
        skip.push(r.spec + '（' + r.note + '）')
        continue
      }
      try {
        const created = await addProduct({
          sku_code: '', // 留空 → 后端按"无条码 1001 递增"自动生成
          barcode: '',
          category,
          sub_category: '',
          brand: brand.trim(),
          model: r.spec,
          cost_price: costFen, // 0 会走后端兜底价（¥2 并标记"默认价"）
          suggest_price: suggestFen,
          location: '',
          // 先挂「待盘点」；下面入库成功会自动翻成「已盘点」。
          // 口径（2026-09-22）：有数量≠0 的批次才算盘过 —— 不从名字/照片推断。
          status: '待盘点',
          unit,
        })
        if (r.qty > 0 && created && created.id) {
          await addInbound({
            productId: created.id,
            quantity: r.qty,
            costPrice: costFen,
            location: null,
            supplierId: null,
            operator: '批量建族',
          })
        }
        ok.push(r.display + (r.qty > 0 ? ` × ${r.qty}` : '（仅建档，待入库）'))
      } catch (e) {
        fail.push(r.spec + '：' + ((e as Error)?.message || '未知错误'))
      }
      done += 1
      setProgress(`已处理 ${done} / ${willCreate}`)
    }
    setResult({ ok, skip, fail })
    setProgress('')
    setBusy(false)
    if (ok.length > 0) onDone?.(ok.length)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>批量建一族规格</DialogTitle>
          <DialogDescription>
            品牌 / 品类 / 进价售价填一次，下面把规格名粘一列（每行一个），一次建出来。
            名字统一由系统拼成「品牌 + 规格」，不用手打。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>品牌 *</Label>
            <BrandField value={brand} onChange={setBrand} listId="brand-choices-batch" />
          </div>
          <div className="space-y-1">
            <Label>品类 *</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as Category)}>
              <SelectTrigger>
                <SelectValue placeholder="选择品类" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {(categories.length > 0 ? categories : [{ name: '其他' }]).map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>进价（元）</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={costYuan}
              onChange={(e) => setCostYuan(e.target.value)}
              placeholder="不填按兜底价 ¥2（会标'默认价'提醒你改）"
            />
          </div>
          <div className="space-y-1">
            <Label>建议售价（元）</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={suggestYuan}
              onChange={(e) => setSuggestYuan(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>计量单位</Label>
            <Select value={unit} onValueChange={(v) => setUnit(v as Unit)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {(units.length > 0 ? units : [{ name: '件', allow_decimal: 0 }]).map((u) => (
                  <SelectItem key={u.name} value={u.name}>
                    {u.name}
                    {u.allow_decimal ? '（可小数）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-1">
            <Label>规格清单（每行一个；想顺手入库就写「规格, 数量」）</Label>
            <textarea
              className="min-h-32 w-full rounded-md border border-slate-200 p-2 font-mono text-sm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'拔群丸世9号 10PCS\n拔群丸世10号 10PCS, 20\n拔群伊豆14号 8PCS'}
            />
          </div>
        </div>

        {preview.length > 0 && (
          <div className="max-h-52 overflow-y-auto rounded-md border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-2 py-1 text-left">建出来的名字（系统拼）</th>
                  <th className="px-2 py-1 text-left">数量</th>
                  <th className="px-2 py-1 text-left">说明</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.line} className={r.skip ? 'text-slate-400' : ''}>
                    <td className="px-2 py-1">{r.display}</td>
                    <td className="px-2 py-1">{r.qty > 0 ? r.qty : '—'}</td>
                    <td className="px-2 py-1">{r.note || (r.qty > 0 ? '建档 + 入库' : '仅建档')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {result && (
          <div className="space-y-1 rounded-md border border-slate-200 p-2 text-sm">
            <div>
              ✅ 建成 <b>{result.ok.length}</b> 个{result.skip.length > 0 ? ` · 跳过 ${result.skip.length}` : ''}
              {result.fail.length > 0 ? ` · 失败 ${result.fail.length}` : ''}
            </div>
            {result.skip.length > 0 && (
              <div className="text-xs text-slate-500">跳过：{result.skip.join('；')}</div>
            )}
            {result.fail.length > 0 && (
              <div className="text-xs text-rose-600">失败：{result.fail.join('；')}</div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            关闭
          </Button>
          <Button onClick={submit} disabled={busy || !brand.trim() || !category || willCreate === 0}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? progress || '建立中...' : `建立这 ${willCreate} 个规格`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
