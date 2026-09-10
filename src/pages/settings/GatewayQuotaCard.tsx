// P0 计费阀门 · 官方 AI 额度卡：余额 / 本月已用 / 功能占比 / 最近流水 / 充值引导 / 老用户补绑激活码
// 数据来源：ai:gatewayQuota（网关真值）+ ai:localUsageStats（本地逐笔流水，含 BYOK 通道）
import { useCallback, useEffect, useState } from 'react'
import { Coins, RefreshCw, Wallet, Link2 } from 'lucide-react'
import { backend } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// TODO(上线前): 替换为真实客服微信号/收款码说明（第一期人工充值，不接在线支付）
const SERVICE_WECHAT = 'juncheng-service'

const FEATURE_NAMES: Record<string, string> = {
  agent_chat: 'AI 对话',
  daily_summary: '打烊日报',
  correct_term: '语音纠错',
  connection_test: '连通测试',
}
const featureName = (f: string) => FEATURE_NAMES[f] ?? f

interface GatewayQuota {
  total: number
  used: number
  remaining: number
  packageType: string | null
  bound: boolean
}
interface UsageRow {
  id: number
  feature: string
  model: string | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
  channel: 'gateway' | 'byok'
  createdAt: string
}
interface Stats {
  monthTotalTokens: number
  byFeature: Array<{ feature: string; channel: string; calls: number; totalTokens: number }>
}

const fmtTokens = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function GatewayQuotaCard() {
  const [quota, setQuota] = useState<GatewayQuota | null>(null)
  const [quotaErr, setQuotaErr] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [recent, setRecent] = useState<UsageRow[]>([])
  const [isGateway, setIsGateway] = useState(true)
  const [showRecharge, setShowRecharge] = useState(false)
  const [bindCode, setBindCode] = useState('')
  const [bindMsg, setBindMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!backend) return
    const [q, s, st] = await Promise.all([
      backend.invoke('ai:gatewayQuota').catch(() => null),
      backend.invoke('ai:localUsageStats').catch(() => null),
      backend.invoke('ai:status').catch(() => null),
    ])
    if (st) setIsGateway(st.providerKey === 'gateway')
    if (q?.ok) { setQuota(q); setQuotaErr(null) } else setQuotaErr(q?.reason ?? '网络不可用')
    if (s?.ok) { setStats(s.stats); setRecent(s.recent ?? []) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const handleBind = async () => {
    if (!backend || !bindCode.trim() || busy) return
    setBusy(true)
    setBindMsg(null)
    try {
      const r = await backend.invoke('ai:bindLicense', { code: bindCode.trim() })
      if (r?.ok) {
        setBindMsg(r.migrated ? '绑定成功，试用余额已迁移到激活码账户' : '绑定成功')
        setBindCode('')
        void refresh()
      } else {
        setBindMsg(r?.error || r?.reason || '绑定失败，请检查激活码')
      }
    } finally {
      setBusy(false)
    }
  }

  const lowBalance = quota && quota.remaining <= 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Coins className="size-5 text-brand-500" />
          官方 AI 额度
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void refresh()}>
            <RefreshCw className="size-4" />
          </Button>
        </CardTitle>
        <CardDescription>
          走官方服务的 AI 功能按 token 计费，账单透明；自备 Key（BYOK）不扣此额度。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!isGateway && (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            当前主力模型是自备 Key，不消耗官方额度。下方统计含两条通道的用量。
          </div>
        )}

        {quotaErr && !quota && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
            余额查询失败（{quotaErr}）。联网后点右上角刷新重试。
          </div>
        )}

        {quota && (
          <>
            <div className="flex items-center justify-between rounded-lg bg-brand-50/60 px-3 py-2 text-sm">
              <span className="text-slate-600">当前余额</span>
              <span className={`font-bold ${lowBalance ? 'text-red-600' : 'text-brand-700'}`}>
                {fmtTokens(quota.remaining)} tokens
              </span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span className="text-slate-600">累计已用 / 总额度</span>
              <span className="text-slate-800">{fmtTokens(quota.used)} / {fmtTokens(quota.total)}</span>
            </div>
            {!quota.bound && (
              <div className="space-y-2 rounded-lg border border-dashed border-brand-300 px-3 py-2">
                <div className="flex items-center gap-1 text-xs text-brand-700">
                  <Link2 className="size-3.5" />
                  未绑定激活码：试用余额换设备不恢复。输入激活码绑定后，余额跟激活码走。
                </div>
                <div className="flex gap-2">
                  <Input
                    value={bindCode}
                    onChange={(e) => setBindCode(e.target.value)}
                    placeholder="ADU-FISH-..."
                    className="h-8 text-xs"
                  />
                  <Button size="sm" disabled={busy || !bindCode.trim()} onClick={() => void handleBind()}>
                    绑定
                  </Button>
                </div>
                {bindMsg && <div className="text-xs text-slate-600">{bindMsg}</div>}
              </div>
            )}
            {lowBalance && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                余额已用完，官方 AI 已暂停（402）。充值或切换自备 Key 继续使用。
              </div>
            )}
            <Button variant="outline" size="sm" className="w-full" onClick={() => setShowRecharge(true)}>
              <Wallet className="mr-1 size-4" /> 去充值
            </Button>
          </>
        )}

        {stats && stats.monthTotalTokens > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-500">本月已用 {fmtTokens(stats.monthTotalTokens)} tokens</div>
            {stats.byFeature
              .filter((r) => r.totalTokens > 0)
              .sort((a, b) => b.totalTokens - a.totalTokens)
              .map((r) => (
                <div key={`${r.feature}-${r.channel}`} className="flex items-center gap-2 text-xs">
                  <span className="w-16 shrink-0 text-slate-600">{featureName(r.feature)}</span>
                  <div className="h-2 flex-1 rounded bg-slate-100">
                    <div
                      className={`h-2 rounded ${r.channel === 'byok' ? 'bg-slate-400' : 'bg-brand-500'}`}
                      style={{ width: `${Math.max(2, Math.round((r.totalTokens / stats.monthTotalTokens) * 100))}%` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right text-slate-500">{fmtTokens(r.totalTokens)}</span>
                </div>
              ))}
          </div>
        )}

        {recent.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-500">最近流水</div>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {recent.map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-xs">
                  <span className="text-slate-500">{String(r.createdAt).replace('T', ' ').slice(5, 16)}</span>
                  <span className="text-slate-700">{featureName(r.feature)}</span>
                  <span className="text-slate-500">{fmtTokens(r.totalTokens)} tok</span>
                  <span className={r.channel === 'byok' ? 'text-slate-400' : 'text-brand-600'}>
                    {r.channel === 'byok' ? '自备' : '官方'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={showRecharge} onOpenChange={setShowRecharge}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>官方 AI 额度充值</DialogTitle>
            <DialogDescription>第一期为人工充值（暂不接在线支付），即时到账。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-slate-700">
            <p>1. 添加客服微信：<span className="font-bold">{SERVICE_WECHAT}</span></p>
            <p>2. 发送你的{quota?.bound ? '激活码' : '机器码'}和想要的套餐（次包 / 月包）</p>
            <p>3. 微信转账后客服即刻充值，回本页点刷新即可看到新余额</p>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
