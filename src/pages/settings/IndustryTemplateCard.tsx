// 行业模板（通用版）：一键套用超市/五金/文具/日杂模板，重置分类与单位
import { useCallback, useEffect, useState } from 'react'
import { LayoutTemplate, CheckCircle2 } from 'lucide-react'
import { backend } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export function IndustryTemplateCard() {
  const [templates, setTemplates] = useState<{ id: string; name: string; desc: string }[]>([])
  const [current, setCurrent] = useState('')
  const [applying, setApplying] = useState('')

  const load = useCallback(async () => {
    try {
      if (backend) {
        const list = await backend.invoke('template:list')
        setTemplates(list)
      }
    } catch { /* 忽略 */ }
    try {
      if (backend) {
        const s = await backend.invoke('data:loadAll')
        const cur = s?.settings?.find?.((x: { key: string }) => x.key === 'industry_template')?.value
        setCurrent(cur || '')
      }
    } catch { /* 忽略 */ }
  }, [])

  useEffect(() => { void load() }, [load])

  const apply = async (id: string) => {
    if (!window.confirm('套用行业模板会重置分类和单位（商品/库存/流水不动），确定？')) return
    setApplying(id)
    try {
      await backend!.invoke('template:apply', { templateId: id })
      setCurrent(id)
      window.alert('已套用行业模板，分类和单位已更新')
    } catch (e) {
      window.alert('套用失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setApplying('')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LayoutTemplate className="size-5 text-brand-500" />
          行业模板
        </CardTitle>
        <CardDescription>一键切换行业：超市/五金/文具/日杂，分类和单位自动配好（商品/库存/流水不动）</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {templates.length === 0 && <div className="text-sm text-slate-500">暂无模板（当前环境不支持）</div>}
        {templates.map((t) => (
          <div key={t.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
            <div className="flex-1">
              <div className="text-sm font-bold text-slate-900">{t.name}</div>
              <div className="text-xs text-slate-500">{t.desc}</div>
            </div>
            {current === t.id ? (
              <span className="flex items-center gap-1 text-sm font-bold text-brand-600">
                <CheckCircle2 className="size-4" />当前
              </span>
            ) : (
              <Button size="sm" variant="outline" disabled={applying === t.id} onClick={() => apply(t.id)}>
                {applying === t.id ? '套用中…' : '套用'}
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
