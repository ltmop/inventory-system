import { useEffect, useState } from 'react'
import { Brain, Loader2, Pencil, Plus, Search, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ErrorBanner, PageHeader, SuccessBanner } from '@/components/feedback'
import { backend } from '@/lib/api'

interface KnowledgeEntry {
  id: number
  kind: string
  content: string
  tags: string | null
  source: string | null
  active: number
  updated_at: string | null
  created_at: string
}

const KIND_LABEL: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  suggestion: '建议',
  knowledge: '知识',
}

const KIND_STYLE: Record<string, string> = {
  fact: 'bg-sky-100 text-sky-700',
  preference: 'bg-purple-100 text-purple-700',
  suggestion: 'bg-amber-100 text-amber-700',
  knowledge: 'bg-emerald-100 text-emerald-700',
}

/** 知识库：AI 记住的店里的事，能搜能管；AI 对话时会检索这里的知识回答 */
export function KnowledgePage() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [kind, setKind] = useState('all')
  const [keyword, setKeyword] = useState('')

  // 新增/编辑弹窗状态
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [formKind, setFormKind] = useState('fact')
  const [formContent, setFormContent] = useState('')
  const [formTags, setFormTags] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    if (!backend) return
    setLoading(true)
    setError('')
    try {
      const rows = await backend.invoke('knowledge:list', {
        kind: kind === 'all' ? null : kind,
        keyword: keyword || null,
        limit: 500,
      })
      setEntries(rows ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载知识库失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, keyword])

  async function handleSave() {
    if (!backend || !formContent.trim()) return
    setSaving(true)
    setError('')
    try {
      if (editing) {
        await backend.invoke('knowledge:update', {
          id: editing.id,
          kind: formKind,
          content: formContent,
          tags: formTags || null,
        })
        setSuccess('已更新')
      } else {
        await backend.invoke('knowledge:save', {
          kind: formKind,
          content: formContent,
          tags: formTags || null,
        })
        setSuccess('已保存到知识库')
      }
      setAddOpen(false)
      setEditing(null)
      setFormKind('fact')
      setFormContent('')
      setFormTags('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    if (!backend) return
    if (!window.confirm('确定删除这条知识？AI 以后就记不得它了。')) return
    try {
      await backend.invoke('knowledge:delete', { id })
      setSuccess('已删除')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  async function toggleActive(e: KnowledgeEntry) {
    if (!backend) return
    try {
      await backend.invoke('knowledge:update', { id: e.id, active: e.active ? 0 : 1 })
      await load()
    } catch {
      // 忽略
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="知识库" subtitle="AI 记住的店里的事，能搜能管；AI 对话时检索这里的知识回答" />

      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <SuccessBanner>{success}</SuccessBanner>}

      {/* 工具栏：搜索 + 类型筛选 + 新增 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜内容/标签..."
            className="w-64 pl-9"
          />
        </div>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="全部类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="fact">事实</SelectItem>
            <SelectItem value="preference">偏好</SelectItem>
            <SelectItem value="suggestion">建议</SelectItem>
            <SelectItem value="knowledge">知识</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => { setAddOpen(true); setEditing(null); setFormKind('fact'); setFormContent(''); setFormTags('') }} className="bg-brand-600 hover:bg-brand-700">
          <Plus className="size-4" /> 新增知识
        </Button>
      </div>

      {/* 新增/编辑弹窗 */}
      {(addOpen || editing) && (
        <Card className="border-2 border-brand-200">
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center gap-2">
              <Brain className="size-5 text-brand-500" />
              <span className="font-bold">{editing ? '编辑知识' : '新增知识'}</span>
              <span className="text-sm text-muted-foreground">写一条店里的事，AI 以后能记着并回答</span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Select value={formKind} onValueChange={setFormKind}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fact">事实</SelectItem>
                  <SelectItem value="preference">偏好</SelectItem>
                  <SelectItem value="suggestion">建议</SelectItem>
                  <SelectItem value="knowledge">知识</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={formTags}
                onChange={(e) => setFormTags(e.target.value)}
                placeholder="标签（逗号分隔，如：补货,伊势尼）"
                className="w-64"
              />
            </div>
            <textarea
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              rows={3}
              placeholder="例如：回头客老李每周五来买伊势尼6号钩，常欠账月底结"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={saving || !formContent.trim()} className="bg-brand-600 hover:bg-brand-700">
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {editing ? '保存修改' : '保存'}
              </Button>
              <Button variant="outline" onClick={() => { setAddOpen(false); setEditing(null) }}>取消</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 列表 */}
      {loading ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" /> 加载中...
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          知识库还是空的。跟 AI 聊天时它发现值得记住的事会自动存进来，也可以点"新增知识"手动写。
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <Card key={e.id} className="transition-shadow hover:shadow-card-hover">
              <CardContent className="flex items-start gap-3 pt-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-bold ${KIND_STYLE[e.kind] ?? KIND_STYLE.fact}`}>
                      {KIND_LABEL[e.kind] ?? e.kind}
                    </span>
                    {e.tags && (
                      <span className="text-xs text-muted-foreground">
                        {e.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t) => (
                          <span key={t} className="mr-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs">{t}</span>
                        ))}
                      </span>
                    )}
                    {e.source && <span className="text-xs text-muted-foreground">来自{e.source}</span>}
                    {e.active === 0 && <span className="text-xs text-red-500">已停用</span>}
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">{e.content}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    存于 {e.created_at ? new Date(e.created_at).toLocaleDateString('zh-CN') : ''}
                  </div>
                </div>
                <div className="flex flex-none items-center gap-1">
                  <Button variant="ghost" size="sm" title={e.active ? '停用' : '启用'} onClick={() => toggleActive(e)}>
                    {e.active ? '停用' : '启用'}
                  </Button>
                  <Button variant="ghost" size="sm" title="编辑" onClick={() => { setEditing(e); setFormKind(e.kind); setFormContent(e.content); setFormTags(e.tags ?? '') }}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="sm" title="删除" className="text-red-600" onClick={() => handleDelete(e.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
