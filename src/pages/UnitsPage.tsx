// 单位管理（通用版）：计量单位 + 小数开关。斤/公斤/米等允许小数（1.5 斤）
import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, ArrowDown, Pencil, Plus, Trash2, Ruler } from 'lucide-react'
import { backend } from '@/lib/api'
import { PageHeading } from '@/components/layout/FeatureGrid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { UnitRow } from '@/types'

export default function UnitsPage() {
  const [units, setUnits] = useState<UnitRow[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newDec, setNewDec] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editDec, setEditDec] = useState(false)

  const load = useCallback(async () => {
    try {
      const rows = await backend!.invoke('unit:list')
      setUnits(rows)
    } catch (e) {
      window.alert('加载单位失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const add = async () => {
    if (!newName.trim()) return
    try {
      await backend!.invoke('unit:create', { name: newName.trim(), allow_decimal: newDec ? 1 : 0 })
      setNewName(''); setNewDec(false)
      await load()
    } catch (e) {
      window.alert('新增失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const save = async (id: number) => {
    if (!editName.trim()) return
    try {
      await backend!.invoke('unit:update', { id, name: editName.trim(), allow_decimal: editDec ? 1 : 0 })
      setEditingId(null)
      await load()
    } catch (e) {
      window.alert('保存失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const remove = async (id: number, name: string) => {
    if (!window.confirm(`确定删除单位「${name}」？被商品使用的单位不能删`)) return
    try {
      await backend!.invoke('unit:delete', { id })
      await load()
    } catch (e) {
      window.alert('删除失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const move = async (id: number, dir: number) => {
    try {
      await backend!.invoke('unit:move', { id, dir })
      await load()
    } catch { /* 已在边界 */ }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeading title="单位管理" desc="计量单位：斤/公斤/米等可开小数（0.5、1.5），件/盒等只能整数" icon={Ruler} />
      <div className="mb-4 space-y-2 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex gap-2">
          <Input placeholder="新单位名，如：斤" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <Button onClick={add} className="shrink-0"><Plus className="mr-1 size-4" />新增</Button>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={newDec} onChange={(e) => setNewDec(e.target.checked)} className="size-4" />
          允许小数（按 0.5 步进，如 1.5 斤）
        </label>
      </div>
      {loading ? (
        <div className="text-sm text-slate-500">加载中…</div>
      ) : (
        <div className="space-y-2">
          {units.length === 0 && <div className="text-sm text-slate-500">还没有单位，先新增一个</div>}
          {units.map((u, idx) => (
            <div key={u.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
              {editingId === u.id ? (
                <>
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8" onKeyDown={(e) => e.key === 'Enter' && save(u.id)} autoFocus />
                  <label className="flex shrink-0 items-center gap-1 text-xs text-slate-500"><input type="checkbox" checked={editDec} onChange={(e) => setEditDec(e.target.checked)} className="size-4" />小数</label>
                  <Button size="sm" onClick={() => save(u.id)}>保存</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>取消</Button>
                </>
              ) : (
                <>
                  <div className="flex-1">
                    <div className="text-[15px] font-bold text-slate-900">{u.name}</div>
                    <div className="text-xs text-slate-500">{u.allow_decimal ? '允许小数（0.5、1.5）' : '只能整数'}</div>
                  </div>
                  <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30" disabled={idx === 0} onClick={() => move(u.id, -1)} title="上移"><ArrowUp className="size-4" /></button>
                  <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30" disabled={idx === units.length - 1} onClick={() => move(u.id, 1)} title="下移"><ArrowDown className="size-4" /></button>
                  <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100" onClick={() => { setEditingId(u.id); setEditName(u.name); setEditDec(!!u.allow_decimal) }} title="编辑"><Pencil className="size-4" /></button>
                  <button className="rounded p-1.5 text-red-400 hover:bg-red-50" onClick={() => remove(u.id, u.name)} title="删除"><Trash2 className="size-4" /></button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
