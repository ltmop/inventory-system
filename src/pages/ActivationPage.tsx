import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, CheckCircle, Copy, Loader2, Key } from 'lucide-react'
import { useLicense, daysText, LEVEL_NAMES } from '@/lib/license'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
// 收款码占位图（老板替换为自己真实的收款码）
import wxQr from '@/assets/wechat-pay.png'
import aliQr from '@/assets/alipay.png'

export function ActivationPage() {
  const navigate = useNavigate()
  const { activated, level, daysLeft, machineId, activate } = useLicense()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const handleCopyMachineId = () => {
    if (!machineId) return
    navigator.clipboard.writeText(machineId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  const handleActivate = async () => {
    const trimmed = code.trim()
    if (!trimmed) {
      setMessage({ ok: false, text: '请输入激活码' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const r = await activate(trimmed)
      setMessage(r.ok
        ? { ok: true, text: '激活成功！Pro 功能已解锁' }
        : { ok: false, text: r.error || '激活失败' })
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#e8eef6] px-4">
      <div className="w-full max-w-lg space-y-6">
        {/* 顶栏 */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 cursor-pointer"
          >
            <ArrowLeft className="size-4" />
            返回
          </button>
          <div className="text-sm text-slate-400">通用进销存系统</div>
        </div>

        {/* 已激活状态 */}
        {activated && (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="flex items-center gap-3">
                <div className="rounded-full bg-green-100 p-2">
                  <CheckCircle className="size-5 text-green-600" />
                </div>
                <div>
                  <div className="font-medium text-slate-800">{LEVEL_NAMES[level] ?? '普通版'} 已激活</div>
                  <div className="text-sm text-slate-500">{LEVEL_NAMES[level] ?? '普通版'} · {daysText(daysLeft)}</div>
                </div>
              </div>
              {daysLeft !== null && daysLeft <= 30 && daysLeft > 0 && (
                <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  订阅即将到期，请及时续费以保持付费功能
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 未激活：激活码输入 */}
        {!activated && (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="flex items-center gap-2 text-slate-700">
                <Key className="size-5 text-brand-600" />
                <span className="font-medium">激活付费版</span>
                <span className="text-sm text-slate-400">进阶 ¥168/年 · 大师 ¥398/年</span>
              </div>

              {/* 机器 ID */}
              <div>
                <div className="mb-1 text-xs text-slate-500">机器 ID（付款时发给客服）</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 select-all rounded bg-slate-100 px-3 py-2 font-mono text-sm text-slate-700">
                    {machineId || '加载中...'}
                  </code>
                  <button
                    onClick={handleCopyMachineId}
                    className="rounded p-2 hover:bg-slate-100 cursor-pointer"
                    title="复制机器ID"
                  >
                    {copied ? <CheckCircle className="size-4 text-green-500" /> : <Copy className="size-4 text-slate-400" />}
                  </button>
                </div>
              </div>

              {/* 激活码输入 */}
              <div>
                <div className="mb-1 text-xs text-slate-500">激活码</div>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="ADU-FISH-XXXX-XXXXXX-XXXXXX-P-..."
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm outline-none focus:border-brand-400"
                  onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                />
              </div>

              <Button onClick={handleActivate} disabled={busy} className="w-full">
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? '验证中...' : '激活'}
              </Button>

              {message && (
                <div className={`rounded-lg px-3 py-2 text-sm ${message.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                  {message.text}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 收款码 */}
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="text-sm font-medium text-slate-700">扫码付款后，将机器 ID 发客服获取激活码</div>
            <div className="grid grid-cols-2 gap-4">
              <div className="text-center">
                <img src={wxQr} alt="微信收款码" className="mx-auto h-32 w-32 rounded-lg border object-contain" />
                <div className="mt-1 text-xs text-slate-400">微信支付</div>
              </div>
              <div className="text-center">
                <img src={aliQr} alt="支付宝收款码" className="mx-auto h-32 w-32 rounded-lg border object-contain" />
                <div className="mt-1 text-xs text-slate-400">支付宝</div>
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              普通版免费（300 商品·1店2人）｜进阶 ¥168/年（1000 商品·3店10人）｜大师 ¥398/年（无限）｜付款后联系客服微信获取激活码
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
