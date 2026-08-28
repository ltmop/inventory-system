import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight, Pencil, ReceiptText, Search, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatPrice, productName } from '@/lib/formatters'
import { usePagination } from '@/lib/usePagination'
import type { InventoryBatch, Product, Supplier } from '@/types'

interface SupplierTableProps {
  /** 已按关键词筛选好的供应商列表，分页切在最后 */
  suppliers: Supplier[]
  /** 一个供应商都没有（区别于"搜索后为空"），空态文案不同 */
  allEmpty: boolean
  keyword: string
  onKeywordChange: (v: string) => void
  productsBySupplier: Map<number, number[]>
  products: Product[]
  batches: InventoryBatch[]
  onOpenStatement: (s: Supplier) => void
  onEdit: (s: Supplier) => void
  onDelete: (s: Supplier) => void
}

/** 供应商主表：行可展开看关联商品；展开状态是纯界面状态，收在这里 */
export function SupplierTable({
  suppliers,
  allEmpty,
  keyword,
  onKeywordChange,
  productsBySupplier,
  products,
  batches,
  onOpenStatement,
  onEdit,
  onDelete,
}: SupplierTableProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const pg = usePagination(suppliers, [suppliers])

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Card>
      <CardContent className="pt-6">
        {/* 搜索框：按名称/联系人/电话过滤 */}
        <div className="relative mb-4 w-72">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            placeholder="搜索供应商名称/联系人..."
            className="pl-9"
          />
        </div>
        {suppliers.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {allEmpty ? '暂无供应商，点击右上角新增' : '没有符合条件的供应商'}
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>名称</TableHead>
                  <TableHead>联系人</TableHead>
                  <TableHead>电话</TableHead>
                  <TableHead>地址</TableHead>
                  <TableHead className="text-right">关联商品数</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pg.pageItems.map((s) => {
                  const productIds = productsBySupplier.get(s.id) ?? []
                  const isOpen = expanded.has(s.id)
                  return (
                    <Fragment key={s.id}>
                      <TableRow>
                        <TableCell>
                          <button
                            onClick={() => toggleExpand(s.id)}
                            className="text-slate-500 hover:text-slate-900 cursor-pointer"
                            title={isOpen ? '收起' : '展开供应商品'}
                          >
                            {isOpen ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
                            )}
                          </button>
                        </TableCell>
                        <TableCell>
                          <button
                            onClick={() => toggleExpand(s.id)}
                            className="font-medium text-sky-700 hover:underline cursor-pointer"
                          >
                            {s.name}
                          </button>
                          {s.notes && (
                            <div className="text-xs text-muted-foreground">{s.notes}</div>
                          )}
                        </TableCell>
                        <TableCell>{s.contact || '-'}</TableCell>
                        <TableCell>{s.phone || '-'}</TableCell>
                        <TableCell>{s.address || '-'}</TableCell>
                        <TableCell className="text-right">{productIds.length}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => onOpenStatement(s)}>
                              <ReceiptText className="size-3" />
                              对账
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => onEdit(s)}>
                              <Pencil className="size-3" />
                              编辑
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-red-600 hover:text-red-700"
                              onClick={() => onDelete(s)}
                            >
                              <Trash2 className="size-3" />
                              删除
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow className="bg-slate-50 hover:bg-slate-50">
                          <TableCell />
                          <TableCell colSpan={6} className="py-3">
                            {productIds.length === 0 ? (
                              <div className="text-xs text-muted-foreground">
                                该供应商暂无供货记录
                              </div>
                            ) : (
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>SKU</TableHead>
                                    <TableHead>品名</TableHead>
                                    <TableHead>品类</TableHead>
                                    <TableHead className="text-right">当前库存</TableHead>
                                    <TableHead className="text-right">最近进价</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {productIds.map((pid) => {
                                    const p = products.find((x) => x.id === pid)
                                    if (!p) return null
                                    const stock = batches
                                      .filter((b) => b.product_id === pid)
                                      .reduce((sum, b) => sum + b.quantity, 0)
                                    return (
                                      <TableRow key={pid}>
                                        <TableCell className="font-mono text-xs">
                                          {p.sku_code}
                                        </TableCell>
                                        <TableCell>{productName(p)}</TableCell>
                                        <TableCell>{p.category}</TableCell>
                                        <TableCell className="text-right">{stock}</TableCell>
                                        <TableCell className="text-right">
                                          {formatPrice(p.cost_price)}
                                        </TableCell>
                                      </TableRow>
                                    )
                                  })}
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
          </>
        )}
      </CardContent>
    </Card>
  )
}
