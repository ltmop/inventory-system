import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import type { Supplier, SupplierStatement } from '@/types'
import { Button } from '@/components/ui/button'
import { ErrorBanner, PageHeader, SuccessBanner } from '@/components/feedback'
import { DeleteSupplierDialog } from './suppliers/DeleteSupplierDialog'
import { SupplierFormDialog, type SupplierForm } from './suppliers/SupplierFormDialog'
import { SupplierStatementDialog } from './suppliers/SupplierStatementDialog'
import { SupplierTable } from './suppliers/SupplierTable'

const EMPTY_FORM: SupplierForm = { name: '', contact: '', phone: '', address: '', notes: '' }

export function SuppliersPage() {
  const suppliers = useAppStore((s) => s.suppliers)
  const batches = useAppStore((s) => s.batches)
  const products = useAppStore((s) => s.products)
  const addSupplier = useAppStore((s) => s.addSupplier)
  const updateSupplier = useAppStore((s) => s.updateSupplier)
  const deleteSupplier = useAppStore((s) => s.deleteSupplier)
  const supplierStatement = useAppStore((s) => s.supplierStatement)
  const paySupplier = useAppStore((s) => s.paySupplier)

  // 供应商对账单弹窗
  const [stmtFor, setStmtFor] = useState<Supplier | null>(null)
  const [stmt, setStmt] = useState<SupplierStatement | null>(null)
  const [stmtLoading, setStmtLoading] = useState(false)

  const openStatement = (s: Supplier) => {
    setStmtFor(s)
    setStmt(null)
    setStmtLoading(true)
    supplierStatement(s.id)
      .then(setStmt)
      .catch((e) => {
        setStmtFor(null)
        setPageError(`对账单加载失败：${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => setStmtLoading(false))
  }

  // 登记付款（v0.1）：落库后刷新对账单，让"已付/还欠"即时变化
  const handlePay = async (supplierId: number, input: { amount: number; method: string; note: string | null; payDate?: string }) => {
    const supplier = suppliers.find((x) => x.id === supplierId)
    await paySupplier({ supplierId, ...input })
    setSuccess(`已登记付给「${supplier?.name ?? ''}」${(input.amount / 100).toFixed(2)} 元`)
    // 弹窗还开着的话刷新数据
    if (stmtFor?.id === supplierId) {
      setStmtLoading(true)
      try {
        setStmt(await supplierStatement(supplierId))
      } catch (e) {
        setPageError(`对账单刷新失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setStmtLoading(false)
      }
    }
  }

  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<SupplierForm>(EMPTY_FORM)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<Supplier | null>(null)
  // P0-1：保存/删除按钮统一忙碌态 + 成功绿条 + 失败红条
  const [saving, setSaving] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [success, setSuccess] = useState('')
  const [pageError, setPageError] = useState('')
  // 按名称/联系人搜索（清单第 19 项）
  const [keyword, setKeyword] = useState('')

  const filteredSuppliers = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return suppliers
    return suppliers.filter((s) =>
      [s.name, s.contact, s.phone].filter(Boolean).join(' ').toLowerCase().includes(kw),
    )
  }, [suppliers, keyword])

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  // 每个供应商关联的商品（经批次反查，去重）
  const productsBySupplier = useMemo(() => {
    const map = new Map<number, number[]>()
    for (const b of batches) {
      if (b.supplier_id === null) continue
      const list = map.get(b.supplier_id) ?? []
      if (!list.includes(b.product_id)) list.push(b.product_id)
      map.set(b.supplier_id, list)
    }
    return map
  }, [batches])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setError('')
    setFormOpen(true)
  }

  const openEdit = (s: Supplier) => {
    setEditingId(s.id)
    setForm({ name: s.name, contact: s.contact, phone: s.phone, address: s.address, notes: s.notes })
    setError('')
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (saving) return
    if (!form.name.trim()) {
      setError('供应商名称不能为空')
      return
    }
    const payload = {
      name: form.name.trim(),
      contact: form.contact.trim(),
      phone: form.phone.trim(),
      address: form.address.trim(),
      notes: form.notes.trim(),
    }
    setSaving(true)
    try {
      if (editingId === null) await addSupplier(payload)
      else await updateSupplier(editingId, payload)
      setFormOpen(false)
      setSuccess(editingId === null ? `已新增供应商「${payload.name}」` : `已保存「${payload.name}」的修改`)
    } catch (e) {
      setFormOpen(false)
      setPageError(`保存供应商失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    try {
      await deleteSupplier(deleting.id)
      setSuccess(`已删除供应商「${deleting.name}」，历史批次保留`)
      setDeleting(null)
    } catch (e) {
      setDeleting(null)
      setPageError(`删除供应商失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="供应商管理"
        subtitle="维护供应商档案，与入库批次关联追溯"
        action={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            新增供应商
          </Button>
        }
      />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {pageError && <ErrorBanner>{pageError}</ErrorBanner>}

      <SupplierTable
        suppliers={filteredSuppliers}
        allEmpty={suppliers.length === 0}
        keyword={keyword}
        onKeywordChange={setKeyword}
        productsBySupplier={productsBySupplier}
        products={products}
        batches={batches}
        onOpenStatement={openStatement}
        onEdit={openEdit}
        onDelete={setDeleting}
      />

      {/* 新增/编辑 Dialog */}
      <SupplierFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        isEdit={editingId !== null}
        form={form}
        onFormChange={setForm}
        error={error}
        saving={saving}
        onSubmit={handleSave}
      />

      {/* 删除确认 Dialog（危险操作二次确认） */}
      <DeleteSupplierDialog
        deleting={deleting}
        busy={deleteBusy}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      {/* 供应商对账单 Dialog：汇总头（含已付/还欠）+ 进货明细 + 付款登记（样式参照客户对账单） */}
      <SupplierStatementDialog
        stmtFor={stmtFor}
        stmt={stmt}
        loading={stmtLoading}
        onClose={() => setStmtFor(null)}
        onPay={handlePay}
      />
    </div>
  )
}
