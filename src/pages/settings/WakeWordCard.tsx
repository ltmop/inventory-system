import { Ear, Loader2, Volume2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { ModelDownloadState } from './ModelDownloadCard'
import { PreferenceRow } from './PreferenceRow'
import { speak, DU_XIAO_DU_SPEAKER } from '@/lib/tts'

interface WakeWordCardProps {
  kws: ModelDownloadState
  wakeOn: boolean
  wakeError: string | null
  onToggleWake: () => void
  hasBackend: boolean
  online: boolean
}

/** 唤醒词监听卡片：下载模型 → 开监听 → 选小杜音色 */
export function WakeWordCard({ kws, wakeOn, wakeError, onToggleWake, hasBackend, online }: WakeWordCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Ear className="size-5 text-brand-500" />
          小杜语音助手
          {kws.ready === true && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-700">
              模型已就绪
            </span>
          )}
        </CardTitle>
        <CardDescription>
          喊「小杜小杜」→ 小杜回「在」→ 你说问题 → 小杜用大模型回答并念出来。麦克风会一直保持开启（说话内容只在本机检测，不出本机）。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {kws.ready !== true && (
          kws.downloading ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Loader2 className="size-4 animate-spin" />
                正在下载唤醒词模型… {kws.percent}%
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full bg-brand-600 transition-all"
                  style={{ width: `${kws.percent}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={kws.startDownload}
                disabled={!hasBackend || !online}
                title={online ? undefined : '当前离线，下载模型需要联网'}
                className="bg-brand-600 hover:bg-brand-700"
              >
                下载唤醒词模型（约5MB）
              </Button>
              <span className="text-sm text-muted-foreground">
                {kws.ready === null ? '正在检查模型状态…' : '先下载模型，才能开启语音助手'}
              </span>
            </div>
          )
        )}
        {kws.error && !kws.downloading && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{kws.error}</div>
        )}
        <div className={kws.ready === true ? '' : 'pointer-events-none opacity-50'}>
          <PreferenceRow
            icon={<Ear className="size-4 text-slate-500" />}
            title="监听「小杜小杜」"
            description="开启后麦克风一直保持开启，随时喊「小杜小杜」唤起 AI 助手；关闭后立即释放麦克风"
            checked={wakeOn}
            onToggle={onToggleWake}
          />

          {/* 小杜音色：固定一个女性声线，不用选 */}
          <div className="flex flex-wrap items-center gap-3 border-t border-input pt-3">
            <Volume2 className="size-4 text-slate-500" />
            <div className="text-sm font-medium text-muted-foreground">小杜的音色</div>
            <span className="text-sm">已固定女性声线</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => speak(`你好，我是小杜，有什么可以帮你？`)}
            >
              试听小杜说话
            </Button>
            <span className="text-xs text-muted-foreground">（固定女声，编号 {DU_XIAO_DU_SPEAKER}）</span>
          </div>
        </div>
        {wakeOn && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
            语音助手已开启：麦克风保持开启中，喊「小杜小杜」试试。不用时建议关掉省电省资源。
          </div>
        )}
        {wakeError && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{wakeError}</div>
        )}
      </CardContent>
    </Card>
  )
}
