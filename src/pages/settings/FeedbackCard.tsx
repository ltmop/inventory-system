import { CheckCircle2, Loader2, MessageSquarePlus, Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

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
            placeholder="接收地址（选填，店主配了才能转发到后台，不填也会保存在本机）"
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
