// 官网 · 联系我们（2026-09-14，「官网联系」A 方案）
//
// 单一事实源在 `electron/site.js`（出厂默认 + 本机 site.json 覆盖），本卡片只读它。
// 为什么要这样：以前客服微信硬编码在 `GatewayQuotaCard` 一处，`ActivationPage` 让客户
// 「联系客服微信获取激活码」却**一个号码都没给**，官网/文档站又在 HelpPage 另写一遍 ——
// 换一次客服微信要改几个文件、重新发版。现在改一处（下面「改一下」或 site.json）就全局生效。
import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Globe, Mail, Pencil, Phone } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { backend } from '@/lib/api'

interface SiteContact {
  ok?: boolean
  site: string
  docs: string
  wechat: string
  phone: string
  email: string
  overridden?: string[]
  /** 本机覆盖文件路径（site.json），用于告诉用户"改的是哪个文件" */
  source?: string
}

/** 只读展示一行（可复制） */
function Row({ label, value, copied, onCopy }: { label: string; value: string; copied: string; onCopy: (v: string) => void }) {
  if (!value) return null
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-medium">{value}</span>
        <button
          onClick={() => onCopy(value)}
          className="cursor-pointer text-slate-400 hover:text-slate-700"
          title={'复制' + label}
        >
          {copied === value ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
        </button>
      </span>
    </div>
  )
}

export function SiteContactCard() {
  const [c, setC] = useState<SiteContact | null>(null)
  const [edit, setEdit] = useState(false)
  const [form, setForm] = useState({ wechat: '', phone: '', email: '', site: '', docs: '' })
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState('')

  const load = async () => {
    if (!backend) return
    try {
      const r = (await backend.invoke('site:contact')) as SiteContact | undefined
      if (r) {
        setC(r)
        setForm({ wechat: r.wechat || '', phone: r.phone || '', email: r.email || '', site: r.site || '', docs: r.docs || '' })
      }
    } catch {
      /* 读不到就不显示，不打扰 */
    }
  }
  useEffect(() => { void load() }, [])

  const openSite = (u: string) => { if (u) window.open(u, '_blank') }
  const copy = async (v: string) => {
    try {
      await navigator.clipboard.writeText(v)
      setCopied(v)
      setTimeout(() => setCopied(''), 1500)
    } catch { /* 剪贴板不给用就算了 */ }
  }
  const save = async () => {
    if (!backend) return
    setMsg('')
    try {
      const r = (await backend.invoke('site:setContact', form)) as { ok?: boolean; error?: string }
      if (r?.ok === false) { setMsg(r.error || '保存失败'); return }
      setMsg('已保存到本机（不用重新发版）')
      setEdit(false)
      void load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    }
  }

  if (!c) return null
  const dirty = (c.overridden || []).length > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="size-5 text-brand-500" />
          官网 · 联系我们
        </CardTitle>
        <CardDescription>有问题找我们：官网、使用说明书、客服微信都在这儿。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => openSite(c.site)}>
            <ExternalLink className="size-4" />
            打开官网
          </Button>
          <Button variant="outline" size="sm" onClick={() => openSite(c.docs)}>
            <ExternalLink className="size-4" />
            使用说明书
          </Button>
          <Button variant="ghost" size="sm" className="gap-1 text-slate-500" onClick={() => setEdit((v) => !v)}>
            <Pencil className="size-3.5" />
            {edit ? '收起' : '改一下'}
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Row label="客服微信" value={c.wechat} copied={copied} onCopy={copy} />
          {c.phone ? <Row label="客服电话" value={c.phone} copied={copied} onCopy={copy} /> : null}
          {c.email ? <Row label="邮箱" value={c.email} copied={copied} onCopy={copy} /> : null}
        </div>

        {!edit && (
          <p className="text-xs text-slate-400">
            {dirty ? '其中 ' + dirty + ' 项是本机改过的' : '以上为出厂默认'}
            {c.source ? '（可改：' + c.source + '）' : ''}
          </p>
        )}

        {edit && (
          <div className="space-y-3 border-t pt-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="flex items-center gap-1.5 text-xs text-slate-500">
                  <Phone className="size-3.5" />客服微信
                </Label>
                <Input value={form.wechat} onChange={(e) => setForm({ ...form, wechat: e.target.value })} placeholder="如：juncheng-service" />
              </div>
              <div className="space-y-1">
                <Label className="flex items-center gap-1.5 text-xs text-slate-500">
                  <Phone className="size-3.5" />客服电话
                </Label>
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="可留空" />
              </div>
              <div className="space-y-1">
                <Label className="flex items-center gap-1.5 text-xs text-slate-500">
                  <Mail className="size-3.5" />邮箱
                </Label>
                <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="可留空" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">官网地址</Label>
                <Input value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">说明书地址</Label>
                <Input value={form.docs} onChange={(e) => setForm({ ...form, docs: e.target.value })} />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => void save()}>保存</Button>
              <span className="text-xs text-slate-500">清空某一项即恢复出厂默认</span>
            </div>
            {msg && <p className="text-xs text-emerald-700">{msg}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
