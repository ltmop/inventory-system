import { useEffect, useMemo, useState } from 'react'
import { Loader2, ScrollText } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { formatDateTime, formatPrice } from '@/lib/formatters'
import { usePagination } from '@/lib/usePagination'
import { PRICE_LEVEL_LABELS, type AuditLogEntry, type PriceLevel } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ErrorBanner, PageHeader } from '@/components/feedback'

const ALL = '__all__'

// 操作类型筛选项（与后端 logAudit 的 action 一致）
const AUDIT_ACTIONS = [
  '入库',
  '出库',
  '退货',
  '换货',
  '改价',
  '盘点',
  '还账',
  '采购收货',
  '新建商品',
  '改商品',
  '删商品',
  '新建客户',
]

// 操作类型徽章配色，一眼区分干了什么
const ACTION_BADGE_CLASS: Record<string, string> = {
  入库: 'bg-green-100 text-green-700',
  采购收货: 'bg-green-100 text-green-700',
  出库: 'bg-orange-100 text-orange-700',
  退货: 'bg-red-100 text-red-700',
  换货: 'bg-purple-100 text-purple-700',
  改价: 'bg-amber-100 text-amber-700',
  盘点: 'bg-sky-100 text-sky-700',
  还账: 'bg-emerald-100 text-emerald-700',
  新建商品: 'bg-blue-100 text-blue-700',
  新建客户: 'bg-blue-100 text-blue-700',
  改商品: 'bg-slate-200 text-slate-600',
  删商品: 'bg-red-100 text-red-700',
}

// detail JSON 里各字段的大白话标签
const DETAIL_LABELS: Record<string, string> = {
  sku: 'SKU',
  quantity: '数量',
  costPrice: '进价',
  cost_price: '进价',
  sellingPrice: '售价',
  totalDue: '应收',
  paidAmount: '实收',
  creditAmount: '赊欠',
  price: '价格',
  tier: '档位',
  amount: '金额',
  method: '方式',
  before: '还之前欠',
  outstanding: '还之后欠',
  counted: '盘点条数',
  min_stock: '安全库存',
  refundPrice: '退款',
  phone: '电话',
}
// 这些字段是金额（分），要用 formatPrice 显示
const MONEY_KEYS = new Set([
  'costPrice',
  'cost_price',
  'sellingPrice',
  'totalDue',
  'paidAmount',
  'creditAmount',
  'price',
  'amount',
  'before',
  'outstanding',
  'refundPrice',
])
// 内部字段不展示给老板看
const HIDDEN_KEYS = new Set(['customerId', 'price_level'])

/** 把 entity + detail 拼成一句大白话，如"光威 赤刃 3.6m x2，应收 ¥170.00" */
function describeEntry(e: AuditLogEntry): string {
  const entity = e.entity ?? ''
  if (!e.detail) return entity || '-'
  let obj: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(e.detail)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>
    }
  } catch {
    obj = null
  }
  // detail 不是 JSON（后端直接写的一句话）：原样接在后面
  if (!obj) return entity ? `${entity}，${e.detail}` : e.detail
  const frags: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '' || HIDDEN_KEYS.has(k)) continue
    const label = DETAIL_LABELS[k] ?? k
    if (MONEY_KEYS.has(k) && typeof v === 'number') {
      frags.push(`${label} ${formatPrice(v)}`)
    } else if (k === 'tier' && typeof v === 'string' && v in PRICE_LEVEL_LABELS) {
      frags.push(`${label} ${PRICE_LEVEL_LABELS[v as PriceLevel]}`)
    } else {
      frags.push(`${label} ${String(v)}`)
    }
  }
  return [entity, ...frags].filter(Boolean).join('，')
}

export function AuditLogPage() {
  const auditLogs = useAppStore((s) => s.auditLogs)
  const loadAuditLogs = useAppStore((s) => s.loadAuditLogs)

  const [action, setAction] = useState(ALL)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Electron 走 audit:list（最近 200 条，可按操作类型筛选）；mock 路径本地已有，无需拉取
  useEffect(() => {
    setLoading(true)
    setError('')
    loadAuditLogs(action === ALL ? undefined : action)
      .catch((e) => setError(`操作日志加载失败：${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setLoading(false))
  }, [action, loadAuditLogs])

  // 客户端再兜底过滤一遍（mock 路径 loadAuditLogs 是 no-op，靠这里筛选），最多显示 200 条
  const rows = useMemo(
    () => auditLogs.filter((e) => action === ALL || e.action === action).slice(0, 200),
    [auditLogs, action],
  )

  // 分页切在筛选之后；换操作类型筛选时回第 1 页
  const pg = usePagination(rows, [rows])

  return (
    <div className="space-y-6">
      <PageHeader
        title="操作日志"
        subtitle="谁在什么时候干了什么，都记在这儿；显示最近 200 条"
      />

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex items-center gap-3">
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="操作类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部操作</SelectItem>
                {AUDIT_ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">共 {rows.length} 条</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在翻记录...
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <ScrollText className="mx-auto mb-3 size-8 text-slate-300" />
              {action === ALL
                ? '还没有操作记录，入库、出库、还账之后这里会自动记一笔'
                : `最近没有「${action}」的记录`}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">时间</TableHead>
                    <TableHead className="w-24">操作</TableHead>
                    <TableHead>内容</TableHead>
                    <TableHead className="w-28">操作员</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pg.pageItems.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(e.created_at)}
                      </TableCell>
                      <TableCell>
                        <Badge className={ACTION_BADGE_CLASS[e.action] ?? 'bg-slate-100 text-slate-600'}>
                          {e.action}
                        </Badge>
                      </TableCell>
                      <TableCell>{describeEntry(e)}</TableCell>
                      <TableCell>{e.operator ?? '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination {...pg} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
