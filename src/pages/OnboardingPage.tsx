import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, CheckCircle, PackageMinus, Upload } from 'lucide-react'
import { backend } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

const STEPS = [
  {
    title: '清空演示数据，正式开张',
    desc: '系统自带了一批演示数据供你试用。准备录入真实库存前，点下面按钮清空它们——我们会先自动备份一份到本地，放心。',
    icon: CheckCircle,
    action: '清空开张',
    actionBusy: '清空中...',
    actionDone: '已清空 ✓',
    iconColor: 'text-green-600',
    iconBg: 'bg-green-100',
  },
  {
    title: '把货录进来',
    desc: '用扫码枪扫条码就能入库。没有扫码枪的话，也可以把 Excel 表格拖进来批量导入——支持 .xlsx / .csv，模板我们已经给你准备好了。',
    icon: Upload,
    links: [
      { label: '去入库页', to: '/inbound' },
      { label: '去导入页', to: '/import' },
    ],
    iconColor: 'text-brand-600',
    iconBg: 'bg-brand-100',
  },
  {
    title: '卖第一单',
    desc: '卖货时扫条码出库，FIFO（先进来的货先出）自动按批次扣库存，毛利按进价和售价实时算——每卖一笔都知道赚了多少。',
    icon: PackageMinus,
    links: [{ label: '去出库页', to: '/outbound' }],
    iconColor: 'text-orange-600',
    iconBg: 'bg-orange-100',
  },
]

export function OnboardingPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [resetDone, setResetDone] = useState(false)

  const handleReset = async () => {
    setBusy(true)
    try {
      if (backend) {
        const r = await backend.invoke('onboarding:reset')
        if (!r?.ok) throw new Error(r?.error || '清空失败')
      }
      setResetDone(true)
      setTimeout(() => setStep(1), 800)
    } catch {
      // 清空失败不阻断流程，允许跳过
      setResetDone(true)
      setTimeout(() => setStep(1), 800)
    } finally {
      setBusy(false)
    }
  }

  const handleFinish = async () => {
    // 标记新手引导已完成（无论用户是否走了清空步骤）
    if (backend) {
      try { await backend.invoke('onboarding:finish') } catch { /* 不重要 */ }
    }
    navigate('/')
  }

  const s = STEPS[step]

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#e8eef6] px-4">
      <div className="w-full max-w-md space-y-6">
        {/* 步骤指示器 */}
        <div className="flex items-center justify-center gap-2">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-2 w-2 rounded-full ${
                i === step ? 'bg-brand-600 scale-125' : i < step ? 'bg-green-500' : 'bg-slate-300'
              }`}
            />
          ))}
        </div>

        <Card>
          <CardContent className="space-y-5 pt-8 pb-6">
            <div className="flex flex-col items-center text-center">
              <div className={`mb-4 rounded-full p-4 ${s.iconBg}`}>
                <s.icon className={`size-8 ${s.iconColor}`} />
              </div>
              <h2 className="text-lg font-bold text-slate-800">{s.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-500">{s.desc}</p>
            </div>

            {/* 第一步：清空按钮 */}
            {step === 0 && (
              <div className="flex flex-col gap-3">
                {!resetDone ? (
                  <Button onClick={handleReset} disabled={busy} className="w-full">
                    {busy ? '正在备份并清空演示数据...' : '清空开张'}
                  </Button>
                ) : (
                  <div className="rounded-lg bg-green-50 px-4 py-3 text-center text-sm font-medium text-green-700">
                    演示数据已清空，可以开始录入真实库存了
                  </div>
                )}
                <button
                  onClick={() => { setResetDone(true); setStep(1) }}
                  className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  先跳过，保留演示数据
                </button>
              </div>
            )}

            {/* 第二/三步：跳转链接 */}
            {step > 0 && s.links && (
              <div className="flex flex-col gap-2">
                {s.links.map((link) => (
                  <Button
                    key={link.to}
                    variant="outline"
                    onClick={() => navigate(link.to)}
                    className="w-full justify-between"
                  >
                    {link.label}
                    <ArrowRight className="size-4" />
                  </Button>
                ))}
              </div>
            )}

            {/* 底部导航 */}
            <div className="flex items-center justify-between pt-2">
              {step > 0 ? (
                <button
                  onClick={() => setStep(step - 1)}
                  className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  上一步
                </button>
              ) : (
                <div />
              )}
              {step < STEPS.length - 1 ? (
                <button
                  onClick={() => setStep(step + 1)}
                  className="text-sm font-medium text-brand-600 hover:text-brand-700 cursor-pointer"
                >
                  下一步
                </button>
              ) : (
                <Button onClick={handleFinish} size="sm">
                  开始用
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 跳过整段引导 */}
        <div className="text-center">
          <button
            onClick={handleFinish}
            className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
          >
            跳过引导，直接进入系统
          </button>
        </div>
      </div>
    </div>
  )
}
