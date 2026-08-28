import type { ReactNode } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** useModelDownload 的返回状态（ASR/TTS/KWS 三个模型同一套） */
export interface ModelDownloadState {
  ready: boolean | null // null=查询中 / true=已下好 / false=未下载
  downloading: boolean
  percent: number
  error: string | null
  startDownload: () => void
}

interface ModelDownloadCardProps {
  icon: ReactNode
  title: string
  description: string
  model: ModelDownloadState
  /** 已就绪时的说明，如「模型已就绪（约78MB），按住说话走本地离线识别。」 */
  readyText: string
  /** 下载按钮文案，如「下载模型（约78MB）」 */
  downloadLabel: string
  /** 未下载时的说明（ready===null 时显示「正在检查模型状态…」） */
  notReadyHint: string
  hasBackend: boolean
  online: boolean
}

/** 语音类模型下载卡片（语音识别/语音合成都长这样）：状态查询 → 下载 → 进度条 */
export function ModelDownloadCard({
  icon,
  title,
  description,
  model,
  readyText,
  downloadLabel,
  notReadyHint,
  hasBackend,
  online,
}: ModelDownloadCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
          {model.ready === true && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-700">
              已就绪
            </span>
          )}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {model.ready === true ? (
          <div className="flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
            <CheckCircle2 className="size-4 shrink-0" />
            {readyText}
          </div>
        ) : model.downloading ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 className="size-4 animate-spin" />
              正在下载{title}… {model.percent}%
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full bg-brand-600 transition-all"
                style={{ width: `${model.percent}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={model.startDownload}
              disabled={!hasBackend || !online}
              title={online ? undefined : '当前离线，下载模型需要联网'}
              className="bg-brand-600 hover:bg-brand-700"
            >
              {downloadLabel}
            </Button>
            <span className="text-sm text-muted-foreground">
              {model.ready === null ? '正在检查模型状态…' : notReadyHint}
            </span>
          </div>
        )}
        {model.error && !model.downloading && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{model.error}</div>
        )}
      </CardContent>
    </Card>
  )
}
