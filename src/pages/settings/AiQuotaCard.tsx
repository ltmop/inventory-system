// AI 视觉识别额度（v3.0）：今日已用/剩余，按版本 普通20/进阶100/大师不限
import { useEffect, useState } from 'react'
import { ScanEye } from 'lucide-react'
import { backend } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface Quota {
  feature: string
  level: 'free' | 'pro' | 'max'
  limit: number
  used: number
  remaining: number
  unlimited: boolean
}

const PLAN_NAMES: Record<string, string> = { free: '普通版', pro: '进阶版', max: '大师版' }

export function AiQuotaCard() {
  const [quota, setQuota] = useState<Quota | null>(null)

  useEffect(() => {
    backend?.invoke('ai:quota').then((q) => q && setQuota(q)).catch(() => {})
  }, [])

  if (!quota) return null
  const planName = PLAN_NAMES[quota.level] ?? '普通版'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScanEye className="size-5 text-brand-500" />
          AI 视觉识别（拍照识别）
        </CardTitle>
        <CardDescription>
          拍照识别进货单/商品自动建档，每日额度按版本（{planName}）。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <span className="text-slate-600">今日已用</span>
          <span className="font-bold text-slate-800">{quota.used} 次</span>
        </div>
        {quota.unlimited ? (
          <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">大师版不限次数 🎉</div>
        ) : (
          <div className="flex items-center justify-between rounded-lg bg-brand-50/60 px-3 py-2 text-sm">
            <span className="text-slate-600">今日剩余</span>
            <span className={`font-bold ${quota.remaining === 0 ? 'text-red-600' : 'text-brand-700'}`}>
              {quota.remaining} / {quota.limit} 次
            </span>
          </div>
        )}
        {!quota.unlimited && quota.remaining === 0 && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            今日额度已用完。升级进阶版（100 次/天）或大师版（不限）可继续用。去设置-激活与授权升级。
          </div>
        )}
      </CardContent>
    </Card>
  )
}
