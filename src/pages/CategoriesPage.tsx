// 分类管理（通用版）：增删改/排序，建档/入库/开单/报表立即生效
import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, ArrowDown, Pencil, Plus, Trash2, Tags } from 'lucide-react'
import { backend } from '@/lib/api'
import { PageHeading } from '@/components/layout/FeatureGrid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { CategoryRow } from '@/types'

export default function CategoriesPage() {
  const [cats, setCats] = useState<CategoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')

  const load = useCallback(async () => {
    try {
      const rows = await backend!.invoke('category:listWithCount')
      setCats(rows)
    } catch (e) {
      window.alert('加载分类失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const add = async () => {
    if (!newName.trim()) return
    try {
      await backend!.invoke('category:create', { name: newName.trim() })
      setNewName('')
      await load()
    } catch (e) {
      window.alert('新增失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const rename = async (id: number) => {
    if (!editName.trim()) return
    try {
      await backend!.invoke('category:rename', { id, name: editName.trim() })
      setEditingId(null)
      await load()
    } catch (e) {
      window.alert('改名失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const remove = async (id: number, name: string) => {
    if (!window.confirm(`确定删除分类「${name}」？有商品的分类不能删`)) return
    try {
      await backend!.invoke('category:delete', { id })
      await load()
    } catch (e) {
      window.alert('删除失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const move = async (id: number, dir: number) => {
    try {
      await backend!.invoke('category:move', { id, dir })
      await load()
    } catch { /* 已在边界 */ }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeading title="分类管理" desc="商品分类：增删改/排序，建档/入库/开单/报表立即生效" icon={Tags} />
      <div className="mb-4 flex gap-2">
        <Input
          placeholder="新分类名，如：饮料"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button onClick={add} className="shrink-0"><Plus className="mr-1 size-4" />新增</Button>
      </div>
      {loading ? (
        <div className="text-sm text-slate-500">加载中…</div>
      ) : (
        <div className="space-y-2">
          {cats.length === 0 && <div className="text-sm text-slate-500">还没有分类，先新增一个</div>}
          {cats.map((c, idx) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
              {editingId === c.id ? (
                <>
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8" onKeyDown={(e) => e.key === 'Enter' && rename(c.id)} autoFocus />
                  <Button size="sm" onClick={() => rename(c.id)}>保存</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>取消</Button>
                </>
              ) : (
                <>
                  <div className="flex-1">
                    <div className="text-[15px] font-bold text-slate-900">{c.name}</div>
                    <div className="text-xs text-slate-500">{c.product_count ?? 0} 个商品</div>
                  </div>
                  <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30" disabled={idx === 0} onClick={() => move(c.id, -1)} title="上移"><ArrowUp className="size-4" /></button>
                  <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-30" disabled={idx === cats.length - 1} onClick={() => move(c.id, 1)} title="下移"><ArrowDown className="size-4" /></button>
                  <button className="rounded p-1.5 text-slate-400 hover:bg-slate-100" onClick={() => { setEditingId(c.id); setEditName(c.name) }} title="改名"><Pencil className="size-4" /></button>
                  <button className="rounded p-1.5 text-red-400 hover:bg-red-50" onClick={() => remove(c.id, c.name)} title="删除"><Trash2 className="size-4" /></button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
