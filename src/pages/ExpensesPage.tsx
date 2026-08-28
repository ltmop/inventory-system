import { useEffect, useMemo, useState } from 'react'
import { Loader2, Pencil, Plus, Trash2, Wallet } from 'lucide-react'

import { useAppStore } from '@/store/appStore'
import { formatPrice, todayStr } from '@/lib/formatters'
import { playSound } from '@/lib/sounds'
import {
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  type Expense,
  type ExpenseCategory,
  type PaymentMethod,
} from '@/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ErrorBanner, PageHeader, SuccessBanner } from '@/components/feedback'

// 支出记账：老板视角的"钱出去了"账本。净利 = 毛利 − 支出（经营报表同口径）

interface ExpenseForm {
  category: ExpenseCategory
  amountYuan: string
  method: PaymentMethod
  supplierId: string // '' = 不关联供应商
  expenseDate: string
  note: string
}

const EMPTY_FORM: ExpenseForm = {
  category: '杂项',
  amountYuan: '',
  method: '现金',
  supplierId: '',
  expenseDate: todayStr(),
  note: '',
}

type RangeKey = 'month' | 'lastMonth' | 'all'

const NO_SUPPLIER = '__none__'

/** 元 → 分；非法/负数返回 null */
function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n <= 0) return null
  return Math.round(n * 100)
}

function monthRange(offset: number): [string, string] {
  const d = new Date()
  const first = new Date(d.getFullYear(), d.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + offset + 1, 0)
  const key = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  return [key(first), key(last)]
}

export function ExpensesPage() {
  const expenses = useAppStore((s) => s.expenses)
  const suppliers = useAppStore((s) => s.suppliers)
  const addExpense = useAppStore((s) => s.addExpense)
  const updateExpense = useAppStore((s) => s.updateExpense)
  const deleteExpense = useAppStore((s) => s.deleteExpense)

  const [success, setSuccess] = useState('')
  const [pageError, setPageError] = useState('')

  // 筛选：时间区间 + 分类
  const [range, setRange] = useState<RangeKey>('month')
  const [categoryFilter, setCategoryFilter] = useState<ExpenseCategory | ''>('')

  // 新增/编辑
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<ExpenseForm>(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  // 删除确认
  const [deleting, setDeleting] = useState<Expense | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  const filtered = useMemo(() => {
    let rows = expenses
    if (range !== 'all') {
      const [from, to] = monthRange(range === 'month' ? 0 : -1)
      rows = rows.filter((e) => e.expense_date >= from && e.expense_date <= to)
    }
    if (categoryFilter) rows = rows.filter((e) => e.category === categoryFilter)
    return rows
  }, [expenses, range, categoryFilter])

  const filteredTotal = filtered.reduce((s, e) => s + e.amount, 0)
  const todayTotal = useMemo(() => {
    const today = todayStr()
    return expenses.filter((e) => e.expense_date === today).reduce((s, e) => s + e.amount, 0)
  }, [expenses])
  const monthTotal = useMemo(() => {
    const [from, to] = monthRange(0)
    return expenses
      .filter((e) => e.expense_date >= from && e.expense_date <= to)
      .reduce((s, e) => s + e.amount, 0)
  }, [expenses])

  const openCreate = () => {
    setEditingId(null)
    setForm({ ...EMPTY_FORM, expenseDate: todayStr() })
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = (e: Expense) => {
    setEditingId(e.id)
    setForm({
      category: e.category,
      amountYuan: (e.amount / 100).toFixed(2),
      method: e.method,
      supplierId: e.supplier_id != null ? String(e.supplier_id) : '',
      expenseDate: e.expense_date,
      note: e.note ?? '',
    })
    setFormError('')
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (saving) return
    const amount = yuanToCents(form.amountYuan)
    if (amount === null) {
      setFormError('金额必须大于 0（单位：元，可带两位小数）')
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.expenseDate)) {
      setFormError('请选择支出日期')
      return
    }
    setSaving(true)
    const payload = {
      category: form.category,
      amount,
      method: form.method,
      supplierId: form.supplierId ? Number(form.supplierId) : null,
      note: form.note,
      expenseDate: form.expenseDate,
    }
    try {
      if (editingId === null) await addExpense(payload)
      else await updateExpense(editingId, payload)
      setFormOpen(false)
      playSound('success')
      setSuccess(
        editingId === null
          ? `已记下「${form.category}」支出 ${formatPrice(amount)}`
          : `已保存「${form.category}」的修改`,
      )
    } catch (e) {
      setFormOpen(false)
      playSound('error')
      setPageError(`保存支出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    try {
      await deleteExpense(deleting.id)
      playSound('success')
      setSuccess(`已删除「${deleting.category}」支出 ${formatPrice(deleting.amount)}`)
      setDeleting(null)
    } catch (e) {
      setDeleting(null)
      playSound('error')
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleteBusy(false)
    }
  }

  const rangeLabel = range === 'month' ? '本月' : range === 'lastMonth' ? '上月' : '全部'

  return (
    <div className="space-y-6">
      <PageHeader
        title="支出记账"
        subtitle="钱出去也记账：进货付款、房租、水电…经营报表里的净利 = 毛利 − 这里的支出"
        action={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            记一笔支出
          </Button>
        }
      />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {pageError && <ErrorBanner>{pageError}</ErrorBanner>}

      {/* 概览：今日 / 本月 */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="pt-6">
            <div className="mb-2 flex items-center gap-2 text-sm text-slate-500">
              <Wallet className="size-4 text-brand-600" />
              今天支出
            </div>
            <div className="text-[32px] font-bold leading-tight tabular-nums text-slate-800">
              {formatPrice(todayTotal)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="mb-2 flex items-center gap-2 text-sm text-slate-500">
              <Wallet className="size-4 text-brand-600" />
              本月支出
            </div>
            <div className="text-[32px] font-bold leading-tight tabular-nums text-slate-800">
              {formatPrice(monthTotal)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          {(['month', 'lastMonth', 'all'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setRange(k)}
              className={`cursor-pointer px-4 py-2 text-sm transition-colors ${
                range === k ? 'bg-brand-600 font-medium text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {k === 'month' ? '本月' : k === 'lastMonth' ? '上月' : '全部'}
            </button>
          ))}
        </div>
        <Select
          value={categoryFilter || '__all__'}
          onValueChange={(v) => setCategoryFilter(v === '__all__' ? '' : (v as ExpenseCategory))}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部分类</SelectItem>
            {EXPENSE_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-slate-500">
          {rangeLabel}共 <span className="font-bold tabular-nums text-slate-700">{formatPrice(filteredTotal)}</span>
        </span>
      </div>

      {/* 支出列表 */}
      <Card>
        <CardContent className="pt-6">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {rangeLabel}还没有支出记录，点右上角「记一笔支出」开始记账
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>分类</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead>方式</TableHead>
                  <TableHead>供应商</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="tabular-nums">{e.expense_date}</TableCell>
                    <TableCell>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                        {e.category}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-red-600">
                      {formatPrice(e.amount)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{e.method}</TableCell>
                    <TableCell className="text-muted-foreground">{e.supplier_name ?? '—'}</TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground" title={e.note ?? ''}>
                      {e.note ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        onClick={() => openEdit(e)}
                        className="mr-2 inline-flex cursor-pointer items-center text-slate-400 hover:text-brand-600"
                        title="编辑"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        onClick={() => setDeleting(e)}
                        className="inline-flex cursor-pointer items-center text-slate-400 hover:text-red-600"
                        title="删除"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 新增/编辑支出 Dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId === null ? '记一笔支出' : '编辑支出'}</DialogTitle>
            <DialogDescription>带 * 为必填项；日期默认今天，补记旧账改日期就行</DialogDescription>
          </DialogHeader>
          {formError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>分类 *</Label>
              <div className="grid grid-cols-3 gap-2">
                {EXPENSE_CATEGORIES.map((c) => (
                  <button
                    type="button"
                    key={c}
                    onClick={() => setForm({ ...form, category: c })}
                    className={`h-11 cursor-pointer rounded-xl border text-sm font-medium transition-colors ${
                      form.category === c
                        ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>金额（元）*</Label>
                <Input
                  autoFocus
                  inputMode="decimal"
                  value={form.amountYuan}
                  onChange={(e) => setForm({ ...form, amountYuan: e.target.value })}
                  placeholder="比如：2800"
                />
              </div>
              <div className="space-y-1">
                <Label>日期 *</Label>
                <Input
                  type="date"
                  value={form.expenseDate}
                  onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>付款方式</Label>
              <div className="grid grid-cols-4 gap-2">
                {PAYMENT_METHODS.map((m) => (
                  <button
                    type="button"
                    key={m}
                    onClick={() => setForm({ ...form, method: m })}
                    className={`h-11 cursor-pointer rounded-xl border text-sm font-medium transition-colors ${
                      form.method === m
                        ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label>关联供应商（进货付款时选）</Label>
              <Select
                value={form.supplierId || NO_SUPPLIER}
                onValueChange={(v) => setForm({ ...form, supplierId: v === NO_SUPPLIER ? '' : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="不关联" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SUPPLIER}>不关联</SelectItem>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>备注</Label>
              <Textarea
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="比如：7 月房租、补货快递费..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 Dialog */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这笔支出？</DialogTitle>
            <DialogDescription>
              {deleting && `「${deleting.category}」${formatPrice(deleting.amount)}（${deleting.expense_date}）删除后经营报表的净利会相应变化`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleteBusy}>
              {deleteBusy && <Loader2 className="size-4 animate-spin" />}
              {deleteBusy ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
