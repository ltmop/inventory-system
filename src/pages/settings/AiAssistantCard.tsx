import { ExternalLink, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Provider {
  key: string
  name: string
  model: string
  keyPage: string
  configured: boolean
  /** 阿东官方 AI 服务：内置连接码，不用填 Key */
  official?: boolean
}

interface AiAssistantCardProps {
  hasBackend: boolean
  aiConfigured: boolean
  keyInput: string
  onKeyInputChange: (v: string) => void
  aiBusy: boolean
  aiMessage: { ok: boolean; text: string } | null
  online: boolean
  providers: Provider[]
  currentProvider: string
  onProviderChange: (p: string) => void
  onSaveKey: () => void
  onClearKey: () => void
  onOpenExternal: (url: string) => void
}

/** AI 助手（多模型提供商）卡片：选主力模型 → 填该模型的 Key 激活 */
export function AiAssistantCard({
  hasBackend,
  aiConfigured,
  keyInput,
  onKeyInputChange,
  aiBusy,
  aiMessage,
  online,
  providers,
  currentProvider,
  onProviderChange,
  onSaveKey,
  onClearKey,
  onOpenExternal,
}: AiAssistantCardProps) {
  const cur = providers.find((p) => p.key === currentProvider)
  const curName = cur?.name ?? currentProvider
  const curPage = cur?.keyPage ?? ''
  const curOfficial = !!cur?.official

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-5 text-brand-500" />
          AI 助手
          {aiConfigured ? (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-700">
              已激活（{curName}）
            </span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-normal text-amber-700">
              未配置
            </span>
          )}
        </CardTitle>
        <CardDescription>
          默认使用「官方 AI」开箱即用，不用自己申请 Key：普通版每日 5 次免费试用，进阶版 100 次，大师版不限。
          也可以切换 Kimi/豆包/GLM 等填自己的 Key（自备 Key 不限次）。使用官方 AI 时，问题会发送到云端 AI 服务分析；自备 Key 则数据不出官方通道。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 模型提供商选择 */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-sm font-medium text-muted-foreground">主力模型</div>
          <Select value={currentProvider} onValueChange={onProviderChange} disabled={!hasBackend || aiBusy}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.name}（{p.official ? '官方服务·免填Key' : p.configured ? '已配Key' : '未配Key'}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 填当前模型的 Key（官方服务不用填，可留空；填了则替换内置连接码） */}
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="password"
            value={keyInput}
            onChange={(e) => onKeyInputChange(e.target.value)}
            placeholder={
              curOfficial
                ? '官方服务已内置连接码（一般不用填；换新连接码时粘贴）'
                : aiConfigured
                  ? `已保存 ${curName} 的 Key（输入新 Key 可替换）`
                  : `粘贴 ${curName} 的 API Key`
            }
            className="w-96 font-mono text-xs"
            disabled={!hasBackend}
          />
          <Button
            onClick={onSaveKey}
            disabled={!hasBackend || aiBusy || !keyInput.trim() || !online}
            title={online ? undefined : '当前离线，验证 Key 需要联网'}
            className="bg-brand-600 hover:bg-brand-700"
          >
            {aiBusy ? '验证中...' : '保存并验证'}
          </Button>
          {aiConfigured && !curOfficial && (
            <Button variant="outline" onClick={onClearKey}>
              停用并删除 Key
            </Button>
          )}
          {!online && (
            <span className="text-xs text-amber-600">当前离线：AI 相关操作需要联网后可用</span>
          )}
        </div>
        {aiMessage && (
          <div
            className={`rounded-lg px-4 py-3 text-sm ${
              aiMessage.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}
          >
            {aiMessage.text}
          </div>
        )}
        <div className="space-y-1 text-xs text-muted-foreground">
          {!curOfficial && (
            <>
              <p>没有 {curName} 的 Key？点这里申请（新用户有赠送额度）：</p>
              <button
                className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                onClick={() => curPage && onOpenExternal(curPage)}
              >
                <ExternalLink className="size-3" />
                打开 {curName} 申请页
              </button>
            </>
          )}
          <p>切换模型后，AI 对话、打烊日报、进货单识别都会用选中的模型。断网时 AI 自动降级不报错。</p>
        </div>
      </CardContent>
    </Card>
  )
}
