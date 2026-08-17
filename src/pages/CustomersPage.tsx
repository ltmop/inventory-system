import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { formatPrice } from '@/lib/formatters'
import { playSound } from '@/lib/sounds'
import { type CustomerStatement, type CustomerWithStats, type PaymentMethod, type PriceLevel } from '@/types'
import { Button } from '@/components/ui/button'
import { ErrorBanner, PageHeader, SuccessBanner } from '@/components/feedback'
import { CustomerDetailDialog } from './customers/CustomerDetailDialog'
import { CustomerFormDialog, type CustomerForm } from './customers/CustomerFormDialog'
import { CustomerTable } from './customers/CustomerTable'
import { DeleteCustomerDialog } from './customers/DeleteCustomerDialog'
import { PayDialog } from './customers/PayDialog'

// price_level 为空字符串 = 零售默认（不设档）
const EMPTY_FORM: CustomerForm = {
  name: '',
  phone: '',
  notes: '',
  price_level: '',
  preferences: '',
}

function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

export function CustomersPage() {
  const customers = useAppStore((s) => s.customers)
  const loadCustomers = useAppStore((s) => s.loadCustomers)
  const addCustomer = useAppStore((s) => s.addCustomer)
  const updateCustomer = useAppStore((s) => s.updateCustomer)
  const deleteCustomer = useAppStore((s) => s.deleteCustomer)
  const recordPayment = useAppStore((s) => s.recordPayment)
  const customerStatement = useAppStore((s) => s.customerStatement)

  const [success, setSuccess] = useState('')
  const [pageError, setPageError] = useState('')

  // 新增/编辑客户
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<CustomerForm>(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  // 删除确认
  const [deleting, setDeleting] = useState<CustomerWithStats | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  // 客户详情（对账单）
  const [detail, setDetail] = useState<CustomerWithStats | null>(null)
  const [statement, setStatement] = useState<CustomerStatement | null>(null)
  const [statementLoading, setStatementLoading] = useState(false)

  // 还账
  const [payOpen, setPayOpen] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState<PaymentMethod>('现金')
  const [payBusy, setPayBusy] = useState(false)
  const [payError, setPayError] = useState('')

  // Electron 环境 loadAll 不含客户，进页面先拉一次（mock 路径本地重算）
  useEffect(() => {
    void loadCustomers().catch((e) =>
      setPageError(`客户列表加载失败：${e instanceof Error ? e.message : String(e)}`),
    )
  }, [loadCustomers])

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  // 讨债清单：欠钱的排最前，按欠款从多到少（分页在 CustomerTable 内部，切在排序之后）
  const sorted = useMemo(() => [...customers].sort((a, b) => b.outstanding - a.outstanding), [customers])
  const debtors = sorted.filter((c) => c.outstanding > 0)
  const totalOwed = debtors.reduce((s, c) => s + c.outstanding, 0)

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = (c: CustomerWithStats) => {
    setEditingId(c.id)
    setForm({
      name: c.name,
      phone: c.phone ?? '',
      notes: c.notes ?? '',
      price_level: (c.price_level ?? '') as PriceLevel | '',
      preferences: c.preferences ?? '',
    })
    setFormError('')
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (saving) return
    if (!form.name.trim()) {
      setFormError('客户姓名不能为空')
      return
    }
    setSaving(true)
    try {
      const payload = { name: form.name, phone: form.phone, notes: form.notes, price_level: form.price_level || null, preferences: form.preferences }
      if (editingId === null) await addCustomer(payload)
      else await updateCustomer(editingId, payload)
      setFormOpen(false)
      playSound('success')
      setSuccess(editingId === null ? `已新增客户「${form.name.trim()}」` : `已保存「${form.name.trim()}」的修改`)
    } catch (e) {
      setFormOpen(false)
      playSound('error')
      setPageError(`保存客户失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    try {
      await deleteCustomer(deleting.id)
      playSound('success')
      setSuccess(`已删除客户「${deleting.name}」`)
      setDeleting(null)
    } catch (e) {
      // 有流水/还款记录会被拒，把后端原因原样亮出来
      setDeleting(null)
      playSound('error')
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleteBusy(false)
    }
  }

  const refreshStatement = async (customerId: number) => {
    setStatementLoading(true)
    try {
      setStatement(await customerStatement(customerId))
    } catch (e) {
      setPageError(`对账单加载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setStatementLoading(false)
    }
  }

  const openDetail = (c: CustomerWithStats) => {
    setDetail(c)
    setStatement(null)
    void refreshStatement(c.id)
  }

  const openPay = () => {
    if (!detail) return
    // 默认填当前欠款（欠 0 或预收时留空让老板自己填）
    setPayAmount(detail.outstanding > 0 ? (detail.outstanding / 100).toFixed(2) : '')
    setPayMethod('现金')
    setPayError('')
    setPayOpen(true)
  }

  const handlePay = async () => {
    if (!detail || payBusy) return
    const amount = yuanToCents(payAmount)
    if (amount === null || amount <= 0) {
      setPayError('请填写还款金额（必须大于 0 元）')
      return
    }
    setPayBusy(true)
    try {
      const r = await recordPayment({ customerId: detail.id, amount, method: payMethod })
      setPayOpen(false)
      playSound('success')
      if (r.outstanding > 0) {
        setSuccess(`已记还账：${detail.name} 还了 ${formatPrice(amount)}，还欠 ${formatPrice(r.outstanding)}`)
      } else if (r.outstanding === 0) {
        setSuccess(`账清了：${detail.name} 欠的钱全部还清`)
      } else {
        setSuccess(`${detail.name} 还多了，预收 ${formatPrice(-r.outstanding)}（下次拿货抵）`)
      }
      void refreshStatement(detail.id)
    } catch (e) {
      playSound('error')
      setPayError(`还账失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPayBusy(false)
    }
  }

  // 详情弹窗里的客户用最新的 store 数据（还账后欠款即时刷新）
  const detailFresh = detail ? (customers.find((c) => c.id === detail.id) ?? detail) : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="客户"
        subtitle="谁欠我钱，一眼看清；点客户名字看对账单、记还账"
        action={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            新增客户
          </Button>
        }
      />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {pageError && <ErrorBanner>{pageError}</ErrorBanner>}

      {debtors.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-[15px] text-red-700">
          有 <span className="font-bold">{debtors.length}</span> 人欠钱，合计欠{' '}
          <span className="text-lg font-bold tabular-nums">{formatPrice(totalOwed)}</span>
        </div>
      )}

      <CustomerTable
        customers={sorted}
        onOpenDetail={openDetail}
        onEdit={openEdit}
        onDelete={setDeleting}
      />

      {/* 新增/编辑客户 Dialog */}
      <CustomerFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        isEdit={editingId !== null}
        form={form}
        onFormChange={setForm}
        error={formError}
        saving={saving}
        onSubmit={handleSave}
      />

      {/* 删除确认 Dialog */}
      <DeleteCustomerDialog
        deleting={deleting}
        busy={deleteBusy}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      {/* 客户详情（对账单）Dialog */}
      <CustomerDetailDialog
        detail={detailFresh}
        onClose={() => setDetail(null)}
        statement={statement}
        statementLoading={statementLoading}
        onOpenPay={openPay}
      />

      {/* 还账 Dialog：大金额输入 + 四个大按钮选方式 */}
      <PayDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        detail={detailFresh}
        amount={payAmount}
        onAmountChange={setPayAmount}
        method={payMethod}
        onMethodChange={setPayMethod}
        error={payError}
        busy={payBusy}
        onSubmit={handlePay}
      />
    </div>
  )
}
