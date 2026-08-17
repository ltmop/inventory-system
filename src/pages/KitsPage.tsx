import { useEffect, useMemo, useState } from 'react'
import { Loader2, PackageOpen, Plus, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { productName } from '@/lib/formatters'
import { PageHeader, ErrorBanner, SuccessBanner } from '@/components/feedback'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/EmptyState'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface KitEditorState {
  id: number | null
  name: string
  items: { productId: number; quantity: number }[]
  productKw: string
  /** 打包一口价（元字符串，空=不设） */
  price: string
  /** 总折扣（百分比字符串，如 90 = 9 折，空=不设） */
  discount: string
}

const EMPTY_EDITOR: KitEditorState = { id: null, name: '', items: [], productKw: '', price: '', discount: '' }

/** 套装管理：一套多个商品（新手套装/绑钩套装等），开单时一键加清单 */
export function KitsPage() {
  const kits = useAppStore((s) => s.kits)
  const kitItems = useAppStore((s) => s.kitItems)
  const products = useAppStore((s) => s.products)
  const saveKit = useAppStore((s) => s.saveKit)
  const deleteKit = useAppStore((s) => s.deleteKit)
  const kitDetail = useAppStore((s) => s.kitDetail)

  const [editor, setEditor] = useState<KitEditorState | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  // 套装明细行数（列表显示）
  const itemCountByKit = useMemo(() => {
    const m = new Map<number, number>()
    for (const i of kitItems) m.set(i.kit_id, (m.get(i.kit_id) ?? 0) + 1)
    return m
  }, [kitItems])

  const openCreate = () => {
    setError('')
    setEditor({ ...EMPTY_EDITOR })
  }

  const openEdit = async (id: number) => {
    setError('')
    try {
      const { kit, items } = await kitDetail(id)
      setEditor({
        id: kit.id,
        name: kit.name,
        items: items.map((it) => ({ productId: it.product_id, quantity: it.quantity })),
        productKw: '',
        price: kit.price != null ? (kit.price / 100).toFixed(2) : '',
        discount: kit.discount_percent != null ? String(kit.discount_percent) : '',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleSave = async () => {
    if (!editor || saving) return
    // 打包价：一口价和总折扣只能设一个
    let price: number | null = null
    let discount: number | null = null
    if (editor.price.trim() !== '' && editor.discount.trim() !== '') {
      setError('一口价和总折扣只能设一个（要打包便宜选一种就行）')
      return
    }
    if (editor.price.trim() !== '') {
      const cents = Math.round(parseFloat(editor.price) * 100)
      if (!Number.isFinite(cents) || cents <= 0) {
        setError('一口价格式不对（要大于 0 元；不设就留空）')
        return
      }
      price = cents
    }
    if (editor.discount.trim() !== '') {
      const d = Number(editor.discount)
      if (!Number.isInteger(d) || d < 1 || d > 100) {
        setError('总折扣要是 1~100 的整数（90 = 9 折；不设就留空）')
        return
      }
      discount = d
    }
    setSaving(true)
    setError('')
    try {
      await saveKit({ id: editor.id ?? undefined, name: editor.name, price, discount_percent: discount, items: editor.items })
      setEditor(null)
      setSuccess(editor.id ? '套装已更新' : '套装已创建')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (deletingId != null) return
    setDeletingId(id)
    setError('')
    try {
      await deleteKit(id)
      setSuccess('套装已删除')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingId(null)
    }
  }

  // 编辑器里加商品：搜索候选（排除已在套装里的）
  const editorMatches = editor?.productKw.trim()
    ? products.filter(
        (p) =>
          !editor.items.some((i) => i.productId === p.id) &&
          [p.sku_code, p.brand, p.model, p.barcode]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(editor.productKw.trim().toLowerCase()),
      ).slice(0, 10)
    : []

  const addItem = (productId: number) => {
    if (!editor) return
    setEditor({ ...editor, items: [...editor.items, { productId, quantity: 1 }], productKw: '' })
  }
  const removeItem = (productId: number) => {
    if (!editor) return
    setEditor({ ...editor, items: editor.items.filter((i) => i.productId !== productId) })
  }
  const changeQty = (productId: number, quantity: number) => {
    if (!editor) return
    setEditor({
      ...editor,
      items: editor.items.map((i) =>
        i.productId === productId ? { ...i, quantity: Math.max(1, Math.round(quantity) || 1) } : i,
      ),
    })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="套装管理"
        subtitle="把常搭着卖的商品绑成一套（新手套装等），开单时一键加清单，不用一个个扫"
        action={<Button onClick={openCreate}><Plus className="size-4" />新建套装</Button>}
      />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PackageOpen className="size-5 text-brand-500" />
            套装（{kits.length}）
          </CardTitle>
        </CardHeader>
        <CardContent>
          {kits.length === 0 ? (
            <EmptyState
              compact
              title="还没有套装"
              desc="比如「新手套装 = 竿+轮+线+钩+漂」，建好后开单页点一下全进清单"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>套装名称</TableHead>
                  <TableHead>打包价</TableHead>
                  <TableHead className="text-right">含商品</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kits.map((k) => {
                  const priceLabel =
                    k.price != null
                      ? `一口价 ${(k.price / 100).toFixed(2)} 元`
                      : k.discount_percent != null
                        ? `${k.discount_percent} 折`
                        : '按现价'
                  return (
                    <TableRow key={k.id}>
                      <TableCell className="font-medium">{k.name}</TableCell>
                      <TableCell className="text-sm text-slate-600">{priceLabel}</TableCell>
                      <TableCell className="text-right">{itemCountByKit.get(k.id) ?? 0} 样</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => openEdit(k.id)}>
                            编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-slate-400 hover:text-red-600"
                            onClick={() => handleDelete(k.id)}
                            disabled={deletingId === k.id}
                          >
                            {deletingId === k.id ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 新建/编辑套装 Dialog */}
      <Dialog open={editor !== null} onOpenChange={(o) => !o && !saving && setEditor(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editor?.id ? '编辑套装' : '新建套装'}</DialogTitle>
            <DialogDescription>
              套装里的商品开单时会自动按各自售价加进清单，价格还能临时改
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-4">
              <div className="space-y-1">
                <Label>套装名称 *</Label>
                <Input
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  placeholder="如：新手套装 / 鲢鳙三件套"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>打包一口价（元）</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={editor.price}
                    onChange={(e) => setEditor({ ...editor, price: e.target.value })}
                    placeholder="如：720"
                  />
                  <div className="text-xs text-muted-foreground">整套固定这个价卖，不拆开算</div>
                </div>
                <div className="space-y-1">
                  <Label>总折扣（%）</Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={editor.discount}
                    onChange={(e) => setEditor({ ...editor, discount: e.target.value })}
                    placeholder="如：90 = 9 折"
                  />
                  <div className="text-xs text-muted-foreground">按组成件现价合计打这个折</div>
                </div>
              </div>
              <div className="space-y-1">
                <Label>加商品（搜索后点一下就加进来）</Label>
                <Input
                  value={editor.productKw}
                  onChange={(e) => setEditor({ ...editor, productKw: e.target.value })}
                  placeholder="输入商品名 / SKU / 条码..."
                />
                {editor.productKw && editorMatches.length > 0 && (
                  <div className="mt-1 max-h-36 overflow-auto rounded-md border">
                    {editorMatches.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => addItem(p.id)}
                        className="flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-slate-50 cursor-pointer"
                      >
                        <span>{productName(p)}</span>
                        <span className="text-xs text-slate-400">{p.sku_code}</span>
                      </button>
                    ))}
                  </div>
                )}
                {editor.productKw && editorMatches.length === 0 && (
                  <p className="mt-1 text-xs text-slate-400">没找到（可能已在套装里）</p>
                )}
              </div>
              {editor.items.length === 0 ? (
                <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  套装里还没有商品，搜索加进来
                </p>
              ) : (
                <div className="max-h-56 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>商品</TableHead>
                        <TableHead className="w-24 text-right">数量</TableHead>
                        <TableHead className="w-14"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {editor.items.map((it) => {
                        const p = products.find((x) => x.id === it.productId)
                        return (
                          <TableRow key={it.productId}>
                            <TableCell className="text-sm">
                              {p ? productName(p) : `#${it.productId}`}
                              {p && <span className="ml-2 font-mono text-xs text-muted-foreground">{p.sku_code}</span>}
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min={1}
                                step={1}
                                value={it.quantity}
                                onChange={(e) => changeQty(it.productId, Number(e.target.value))}
                                className="ml-auto h-8 w-20 text-right"
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <button onClick={() => removeItem(it.productId)} className="text-xs text-slate-400 hover:text-red-500 cursor-pointer">
                                移除
                              </button>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditor(null)} disabled={saving}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? '保存中...' : '保存套装'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
