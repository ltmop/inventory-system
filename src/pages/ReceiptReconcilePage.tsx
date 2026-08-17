// 收款对账（v3.0，全版本开放）：每天登记微信/支付宝/现金实收，系统算 应收 vs 实收 vs 赊账 vs 差异。
// 不用翻支付账单——系统每天告诉老板钱对不对得上。
import { useCallback, useEffect, useState } from 'react'
import { backend } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Wallet, CheckCircle2, AlertTriangle } from 'lucide-react'

const METHODS = ['现金', '微信', '支付宝', '其他'] as const
const METHOD_EMOJI: Record<string, string> = { 现金: '💵', 微信: '💚', 支付宝: '🅰️', 其他: '📒' }

function todayStr(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const fmt = (fen: number) => (fen / 100).toFixed(2)

interface Recon {
  date: string
  revenue: number
  byMethod: Record<string, number>
  totalReceived: number
  credit: number
  difference: number
  outCount: number
}

export function ReceiptReconcilePage() {
  const [date, setDate] = useState(todayStr())
  const [recon, setRecon] = useState<Recon | null>(null)
  const [method, setMethod] = useState<(typeof METHODS)[number]>('微信')
  const [amountYuan, setAmountYuan] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async (d: string) => {
    try {
      const r = await backend?.invoke('receipt:reconcile', { date: d })
      if (r) setRecon(r)
    } catch {
      setRecon(null)
    }
  }, [])

  useEffect(() => { load(date) }, [date, load])

  const register = async () => {
    const cents = Math.round(parseFloat(amountYuan || '') * 100)
    if (!Number.isFinite(cents) || cents < 0) {
      setMsg({ ok: false, text: '金额格式不对' })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      await backend?.invoke('receipt:register', { date, method, amount: cents, operator: '桌面' })
      setMsg({ ok: true, text: `${method} ${fmt(cents)} 元已登记` })
      setAmountYuan('')
      await load(date)
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const diffZero = recon ? Math.abs(recon.difference) < 0.5 : true

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">收款对账</h1>
        <div className="flex items-center gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
        </div>
      </div>

      {/* 对账主卡片 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-5 text-brand-600" />
            {date} · 日结对账
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 应收 vs 实收 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-slate-50 p-4">
              <div className="text-xs text-slate-500">应收（营业额）</div>
              <div className="mt-1 text-2xl font-bold text-slate-800">¥{fmt(recon?.revenue ?? 0)}</div>
              <div className="text-xs text-slate-400">{recon?.outCount ?? 0} 笔销售</div>
            </div>
            <div className="rounded-xl bg-green-50 p-4">
              <div className="text-xs text-slate-500">实收登记</div>
              <div className="mt-1 text-2xl font-bold text-green-700">¥{fmt(recon?.totalReceived ?? 0)}</div>
              <div className="text-xs text-slate-400">
                {METHODS.map((m) => (recon?.byMethod?.[m] ?? 0) > 0 ? `${m} ${fmt(recon!.byMethod[m] ?? 0)}` : '').filter(Boolean).join(' · ') || '未登记'}
              </div>
            </div>
            <div className="rounded-xl bg-amber-50 p-4">
              <div className="text-xs text-slate-500">赊账未收</div>
              <div className="mt-1 text-2xl font-bold text-amber-700">¥{fmt(recon?.credit ?? 0)}</div>
              <div className="text-xs text-slate-400">赊给客户的还没收</div>
            </div>
            <div className={`rounded-xl p-4 ${diffZero ? 'bg-green-50' : 'bg-red-50'}`}>
              <div className="text-xs text-slate-500">差异</div>
              <div className={`mt-1 text-2xl font-bold ${diffZero ? 'text-green-700' : 'text-red-600'}`}>
                {diffZero ? '✓ 账平' : `¥${fmt(recon?.difference ?? 0)}`}
              </div>
              <div className="text-xs text-slate-400">{diffZero ? '应收对上了' : '对不上，查一下漏记/多记'}</div>
            </div>
          </div>

          {!diffZero && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                应收 ¥{fmt(recon?.revenue ?? 0)} = 实收 ¥{fmt(recon?.totalReceived ?? 0)} + 赊账 ¥{fmt(recon?.credit ?? 0)} + 差异
                ¥{fmt(recon?.difference ?? 0)}。差异非 0 通常是：微信/支付宝实收没登记、或登记了但钱还没到账。
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 登记实收 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="size-5 text-green-600" />
            登记实收（{date}）
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            {METHODS.map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
                  method === m ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {METHOD_EMOJI[m]} {m}
                {(recon?.byMethod?.[m] ?? 0) > 0 && (
                  <span className="ml-1 text-xs text-slate-400">¥{fmt(recon!.byMethod[m] ?? 0)}</span>
                )}
              </button>
            ))}
            <div className="flex items-end gap-2">
              <div>
                <div className="mb-1 text-xs text-slate-500">金额（元）</div>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={amountYuan}
                  onChange={(e) => setAmountYuan(e.target.value)}
                  placeholder="如：586.50"
                  className="w-36"
                  onKeyDown={(e) => e.key === 'Enter' && register()}
                />
              </div>
              <Button onClick={register} disabled={saving}>
                {saving ? '登记中...' : '登记'}
              </Button>
            </div>
          </div>
          {msg && (
            <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
              {msg.text}
            </div>
          )}
          <div className="mt-3 text-xs text-slate-400">
            每天打烊前把微信/支付宝/现金实收登记一下，系统自动告诉你钱对不对得上。登记可随时改（同方式覆盖）。
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
