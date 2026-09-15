import { useEffect, useState } from 'react'
import { CheckCircle2, Copy, Loader2, MessageSquarePlus, Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { backend } from '@/lib/api'

interface FeedbackCardProps {
  hasBackend: boolean
  message: string
  onMessageChange: (v: string) => void
  contact: string
  onContactChange: (v: string) => void
  webhook: string
  onWebhookChange: (v: string) => void
  busy: boolean
  result: { ok: boolean; text: string } | null
  onSend: () => void
}

/** 意见反馈卡片：写两句发到接收地址（飞书机器人 webhook），自动带版本和系统信息 */
export function FeedbackCard({
  hasBackend,
  message,
  onMessageChange,
  contact,
  onContactChange,
  webhook,
  onWebhookChange,
  busy,
  result,
  onSend,
}: FeedbackCardProps) {
  // 我们的联系方式：与「官网 · 联系我们」同一份事实源（electron/site.js），不在这里写死
  const [ours, setOurs] = useState<{ wechat?: string; email?: string }>({})
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!backend) return
    backend.invoke('site:contact')
      .then((r) => { if (r) setOurs({ wechat: r.wechat || '', email: r.email || '' }) })
      .catch(() => { /* 读不到就不显示 */ })
  }, [])

  /**
   * 一键复制反馈内容。
   * 为什么要有（owner 2026-09-14 反馈「意见反馈邮箱没用」）：
   *   那个「接收地址」**只支持飞书机器人的 https 地址**，填邮箱进去是不会发出去的（只存本机）。
   *   与其让老板配一个发不出去的邮箱，不如让他把内容一键复制、直接从微信/邮箱发给我们。
   */
  const copyContent = async () => {
    const text = [message.trim(), contact.trim() ? `联系方式：${contact.trim()}` : ''].filter(Boolean).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      window.prompt('复制失败，请手动复制下面的内容：', text)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquarePlus className="size-5 text-brand-500" />
          意见反馈
        </CardTitle>
        <CardDescription>
          用得不顺手、想要新功能，写两句直接发给我们。提交时会自动带上软件版本和系统信息，方便排查。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="哪里不好用？想要什么功能？写几句就行"
          rows={4}
          disabled={!hasBackend}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={contact}
            onChange={(e) => onContactChange(e.target.value)}
            placeholder="留个电话/微信，方便我们回复你（选填）"
            className="w-80"
            disabled={!hasBackend}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={webhook}
            onChange={(e) => onWebhookChange(e.target.value)}
            placeholder="飞书机器人地址（选填，必须是 https://…）"
            className="w-96 font-mono text-xs"
            disabled={!hasBackend}
          />
          <Button
            onClick={onSend}
            disabled={!hasBackend || busy || !message.trim()}
            className="bg-brand-600 hover:bg-brand-700"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {busy ? '发送中...' : '提交反馈'}
          </Button>
          <Button variant="outline" onClick={() => void copyContent()} disabled={!message.trim()}>
            {copied ? <CheckCircle2 className="size-4 text-green-600" /> : <Copy className="size-4" />}
            {copied ? '已复制' : '复制内容'}
          </Button>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          {/* 说清楚这个框是什么、不是什么 —— 老板填邮箱进去是发不出去的 */}
          <p>· 「飞书机器人地址」只有店主配了自己的飞书机器人才用得上；<b>填邮箱没用</b>，它不会发邮件。</p>
          <p>· 不填也能提交：反馈会存到本机（数据目录的 feedback.log），你说一声我们就能取。</p>
          {(ours.wechat || ours.email) && (
            <p>
              · 想直接找我们：{ours.wechat ? `客服微信 ${ours.wechat}` : ''}
              {ours.wechat && ours.email ? ' · ' : ''}
              {ours.email ? `邮箱 ${ours.email}` : ''}
              （点上面的「复制内容」，粘给我们即可）
            </p>
          )}
        </div>
        {result && (
          <div
            className={`flex items-start gap-2 rounded-lg px-4 py-3 text-sm ${
              result.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}
          >
            {result.ok && <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            {result.text}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
