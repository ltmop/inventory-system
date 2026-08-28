import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight, Fish, History, Pencil, Tag, Trash2, ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Pagination } from '@/components/ui/pagination'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDate, formatPrice } from '@/lib/formatters'
import { EmptyState } from '@/components/EmptyState'
import { productPhotoUrl } from '@/lib/photo'
import { formatSpecs } from '@/lib/productSpecs'
import { usePagination } from '@/lib/usePagination'
import { cn } from '@/lib/utils'
import type { ExpiringProduct, InventoryBatch, Product, ProductStatus, Supplier } from '@/types'

export const LOW_STOCK_THRESHOLD = 5

/** 本地日期串 YYYY-MM-DD（批次到期日比较用，避免 UTC 时区偏移） */
function todayKeyStr() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 状态标签配色：绿=正常，金=待处理，红=售罄
const STATUS_BADGE_VARIANT: Record<ProductStatus, 'seal-green' | 'seal-sand' | 'seal-purple' | 'seal-red' | 'seal-gray'> = {
  已盘点: 'seal-green',
  待盘点: 'seal-sand',
  在售: 'seal-purple',
  已售罄: 'seal-red',
  停产: 'seal-gray',
}

type SortDir = 'asc' | 'desc'
type BatchSortKey = 'quantity' | 'cost_price' | 'inbound_date'

// 表头排序方向小箭头：未排序时显示灰色双向箭头，提示这一列可以点
function SortIcon({ dir }: { dir: SortDir | null }) {
  if (dir === 'asc') return <ArrowUp className="size-3.5" />
  if (dir === 'desc') return <ArrowDown className="size-3.5" />
  return <ArrowUpDown className="size-3.5 opacity-40" />
}

interface InventoryTableProps {
  /** 已「先筛选后排序」好的商品列表，分页切在最后（按主表行数算，展开的批次子表不占行数） */
  products: Product[]
  /** 一个商品都没有（区别于"筛选后为空"），空态文案不同 */
  allEmpty: boolean
  totalStockOf: (productId: number) => number
  batchesOf: (productId: number) => InventoryBatch[]
  suppliers: Supplier[]
  expiringMap: Map<number, ExpiringProduct>
  stockSort: SortDir | null
  onToggleStockSort: () => void
  onLabel: (p: Product) => void
  onEdit: (p: Product) => void
  onDelete: (p: Product) => void
  /** 库存变动历史入口 */
  onHistory: (p: Product) => void
  /** 多选（批量操作用）：勾选状态由父组件持有，跨页保留 */
  selectedIds: Set<number>
  onToggleSelect: (id: number) => void
  /** 表头全选/取消全选（只作用当前页的行） */
  onTogglePage: (ids: number[], checked: boolean) => void
}

/** 库存主表：商品行可展开批次子表；批次子表排序/展开状态是纯界面状态，收在这里 */
export function InventoryTable({
  products,
  allEmpty,
  totalStockOf,
  batchesOf,
  suppliers,
  expiringMap,
  stockSort,
  onToggleStockSort,
  onLabel,
  onEdit,
  onDelete,
  onHistory,
  selectedIds,
  onToggleSelect,
  onTogglePage,
}: InventoryTableProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  // 批次子表排序（纯前端，不动数据层）：按数量/单价/入库日期
  const [batchSort, setBatchSort] = useState<{ key: BatchSortKey; dir: SortDir } | null>(null)
  // 点缩略图弹大图预览（存的是 fi-img:// 地址，关弹窗即清）
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const pg = usePagination(products, [products])

  // 表头全选（只管当前页）：全选=true，部分='indeterminate'，都没选=false
  const pageIds = pg.pageItems.map((p) => p.id)
  const pageSelectedCount = pageIds.filter((id) => selectedIds.has(id)).length
  const pageCheckState: boolean | 'indeterminate' =
    pageIds.length > 0 && pageSelectedCount === pageIds.length
      ? true
      : pageSelectedCount > 0
        ? 'indeterminate'
        : false

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleBatchSort = (key: BatchSortKey) =>
    setBatchSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: 'asc' }
      return cur.dir === 'asc' ? { key, dir: 'desc' } : null
    })

  const sortBatchList = (list: InventoryBatch[]) => {
    if (!batchSort) return list
    return [...list].sort((a, b) => {
      const d =
        batchSort.key === 'inbound_date'
          ? a.inbound_date.localeCompare(b.inbound_date)
          : a[batchSort.key] - b[batchSort.key]
      return (batchSort.dir === 'asc' ? d : -d) || a.id - b.id
    })
  }

  return (
    <Card>
      <CardContent className="pt-6">
        {products.length === 0 ? (
          <EmptyState
            compact
            title={allEmpty ? '还没有商品' : '没有符合条件的商品'}
            desc={allEmpty
              ? '点左边「扫码入库」，扫一下条码就能录入第一件货'
              : '换个关键词或筛选条件试试'}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={pageCheckState}
                      onCheckedChange={(v) => onTogglePage(pageIds, v === true)}
                      title="全选当前页"
                      aria-label="全选当前页"
                    />
                  </TableHead>
                  <TableHead className="w-10" />
                  <TableHead className="w-14">图片</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>品类</TableHead>
                  <TableHead>品牌</TableHead>
                  <TableHead>型号规格</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">
                    <button
                      onClick={onToggleStockSort}
                      className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground/60"
                      title="点击按库存数量排序"
                    >
                      总库存
                      <SortIcon dir={stockSort} />
                    </button>
                  </TableHead>
                  <TableHead>货位</TableHead>
                  <TableHead className="w-28 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pg.pageItems.map((p) => {
                  const total = totalStockOf(p.id)
                  const low = total < (p.min_stock ?? LOW_STOCK_THRESHOLD)
                  const isOpen = expanded.has(p.id)
                  return (
                    <Fragment key={p.id}>
                      {/* 行高压到 py-1.5 + 小号操作按钮：一屏能多看几行货，又不至于挤 */}
                      <TableRow className={cn(low && 'bg-red-50 hover:bg-red-100')}>
                        <TableCell className="py-1.5">
                          <Checkbox
                            checked={selectedIds.has(p.id)}
                            onCheckedChange={() => onToggleSelect(p.id)}
                            aria-label={`选中 ${p.sku_code}`}
                          />
                        </TableCell>
                        <TableCell className="py-1.5">
                          <button
                            onClick={() => toggleExpand(p.id)}
                            className="text-slate-500 hover:text-slate-900 cursor-pointer"
                            title={isOpen ? '收起批次' : '展开批次'}
                          >
                            {isOpen ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
                            )}
                          </button>
                        </TableCell>
                        {/* 缩略图：有图 48x48 圆角、点开看大图；无图灰色鱼图标占位。
                            URL 带 updated_at 做缓存穿透（换图后文件名不变，靠它让 <img> 重新拉） */}
                        <TableCell className="py-1.5">
                          {(() => {
                            const url = productPhotoUrl(p.photo_path, p.updated_at)
                            if (!url) {
                              return (
                                <div
                                  className="flex size-12 items-center justify-center rounded-md bg-slate-100 text-slate-300"
                                  title="还没有商品图片，点右边铅笔编辑时可以加"
                                >
                                  <Fish className="size-6" />
                                </div>
                              )
                            }
                            return (
                              <button
                                onClick={() => setPreviewUrl(url)}
                                className="block size-12 cursor-zoom-in overflow-hidden rounded-md border"
                                title="点一下看大图"
                              >
                                <img src={url} alt="" className="size-full object-cover" />
                              </button>
                            )
                          })()}
                        </TableCell>
                        <TableCell className="py-1.5 font-mono text-xs">{p.sku_code}</TableCell>
                        <TableCell className="py-1.5">{p.category}</TableCell>
                        <TableCell className="py-1.5">{p.brand ?? '—'}</TableCell>
                        <TableCell className="py-1.5">
                          {p.model ?? '—'}
                          {(() => {
                            const ex = expiringMap.get(p.id)
                            if (!ex) return null
                            return (
                              <Badge
                                className={`ml-2 ${ex.expired ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}
                                title={`保质期到 ${ex.expiry_date}`}
                              >
                                {ex.expired
                                  ? '已过期'
                                  : ex.daysLeft === 0
                                    ? '今天过期'
                                    : `${ex.daysLeft} 天后过期`}
                              </Badge>
                            )
                          })()}
                        </TableCell>
                        <TableCell className="py-1.5">
                          <Badge variant={STATUS_BADGE_VARIANT[p.status]}>{p.status}</Badge>
                        </TableCell>
                        <TableCell
                          className={cn('py-1.5 text-right font-medium', low && 'text-red-600')}
                        >
                          {total}
                        </TableCell>
                        <TableCell className="py-1.5">{p.location ?? '-'}</TableCell>
                        <TableCell className="py-1.5 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="库存变动历史"
                              onClick={() => onHistory(p)}
                            >
                              <History className="size-4 text-slate-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="打印价格标签"
                              onClick={() => onLabel(p)}
                            >
                              <Tag className="size-4 text-brand-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="编辑商品"
                              onClick={() => onEdit(p)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="删除商品"
                              onClick={() => onDelete(p)}
                            >
                              <Trash2 className="size-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={`${p.id}-batches`} className="bg-slate-50 hover:bg-slate-50">
                          <TableCell />
                          <TableCell />
                          <TableCell colSpan={9} className="py-3">
                            {formatSpecs(p) && (
                              <div className="mb-2 text-xs text-slate-500">
                                规格：<span className="font-medium text-slate-700">{formatSpecs(p)}</span>
                              </div>
                            )}
                            {batchesOf(p.id).length === 0 ? (
                              <div className="text-xs text-muted-foreground">无批次库存</div>
                            ) : (
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>批次号</TableHead>
                                    <TableHead className="text-right">
                                      <button
                                        onClick={() => toggleBatchSort('quantity')}
                                        className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground/60"
                                        title="点击按数量排序"
                                      >
                                        数量
                                        <SortIcon
                                          dir={batchSort?.key === 'quantity' ? batchSort.dir : null}
                                        />
                                      </button>
                                    </TableHead>
                                    <TableHead className="text-right">
                                      <button
                                        onClick={() => toggleBatchSort('cost_price')}
                                        className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground/60"
                                        title="点击按成本价排序"
                                      >
                                        单价
                                        <SortIcon
                                          dir={
                                            batchSort?.key === 'cost_price' ? batchSort.dir : null
                                          }
                                        />
                                      </button>
                                    </TableHead>
                                    <TableHead>
                                      <button
                                        onClick={() => toggleBatchSort('inbound_date')}
                                        className="flex cursor-pointer items-center gap-1 hover:text-foreground/60"
                                        title="点击按入库日期排序"
                                      >
                                        入库日期
                                        <SortIcon
                                          dir={
                                            batchSort?.key === 'inbound_date'
                                              ? batchSort.dir
                                              : null
                                          }
                                        />
                                      </button>
                                    </TableHead>
                                    <TableHead>到期日</TableHead>
                                    <TableHead>货位</TableHead>
                                    <TableHead>供应商</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {sortBatchList(batchesOf(p.id)).map((b) => (
                                    <TableRow key={b.id}>
                                      <TableCell className="font-mono text-xs">
                                        {b.batch_no}
                                      </TableCell>
                                      <TableCell className="text-right">{b.quantity}</TableCell>
                                      <TableCell className="text-right">
                                        {formatPrice(b.cost_price)}
                                      </TableCell>
                                      <TableCell>{formatDate(b.inbound_date)}</TableCell>
                                      <TableCell>
                                        {b.expiry_date ? (
                                          <span
                                            className={
                                              b.expiry_date < todayKeyStr()
                                                ? 'font-medium text-red-600'
                                                : 'text-amber-600'
                                            }
                                          >
                                            {formatDate(b.expiry_date)}
                                            {b.expiry_date < todayKeyStr() && ' 已过期'}
                                          </span>
                                        ) : (
                                          '-'
                                        )}
                                      </TableCell>
                                      <TableCell>{b.location ?? '-'}</TableCell>
                                      <TableCell>
                                        {suppliers.find((s) => s.id === b.supplier_id)?.name ??
                                          '-'}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
            <Pagination {...pg} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} />
            {/* 缩略图点开的大图预览 */}
            <Dialog open={previewUrl !== null} onOpenChange={(open) => !open && setPreviewUrl(null)}>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>商品图片</DialogTitle>
                </DialogHeader>
                {previewUrl && (
                  <img
                    src={previewUrl}
                    alt="商品图片"
                    className="mx-auto max-h-[70vh] rounded-md"
                  />
                )}
              </DialogContent>
            </Dialog>
          </>
        )}
      </CardContent>
    </Card>
  )
}
