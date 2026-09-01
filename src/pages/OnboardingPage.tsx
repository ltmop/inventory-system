import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import { ArrowRight, CheckCircle, CloudUpload, PackageMinus, Sparkles, Trash2 } from 'lucide-react'
import { backend } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

// M2-3：「10 分钟上手」重做。真实店必须清 demo，所以保留「清空演示」为开张第一步；
// 计划书的 3 步（注册云账号 / 演示开单 / 体验 AI）全部保留。
interface Step {
  title: string
  sub: string
  desc: string
  icon: typeof CloudUpload
  iconColor: string
  iconBg: string
  points: string[]
}

const STEPS: Step[] = [
  {
    title: '清空演示数据 · 正式开张',
    sub: '从零开始录真货',
    desc: '系统自带演示数据供体验。正式开店前清空它们，我们会先自动备份一份到本地，放心倒入真实库存。',
    icon: Trash2,
    iconColor: 'text-green-600',
    iconBg: 'bg-green-100',
    points: ['清空前自动备份', '扫码/Excel 批量录入', '品类·品牌·型号任意建'],
  },
  {
    title: '注册云账号 · 数据互通',
    sub: '让它跟着你走',
    desc: '登录云账号后，多台电脑/手机自动同步、云端自动备份——换设备、换电脑都不丢货。不注册也能用，数据只在本机。',
    icon: CloudUpload,
    iconColor: 'text-blue-600',
    iconBg: 'bg-blue-100',
    points: ['多台设备自动同步', '云端随时自动备份', '换电脑不丢数据'],
  },
  {
    title: '演示开单 · 卖第一单',
    sub: '10 分钟上手',
    desc: '扫条码出库，先进先出（FIFO）自动按批次扣库存，毛利按进价售价实时算——每卖一笔都知道赚了多少。',
    icon: PackageMinus,
    iconColor: 'text-orange-600',
    iconBg: 'bg-orange-100',
    points: ['扫码/语音开单', 'FIFO 自动扣库存', '毛利实时算给老板看'],
  },
  {
    title: '体验 AI · 问/说/拍',
    sub: 'AI 是能力不是页面',
    desc: '问 AI 今天该补什么货、拍照录进货单、按住说话开单——打开就能看见，随手就能用，不用去学。',
    icon: Sparkles,
    iconColor: 'text-brand-600',
    iconBg: 'bg-brand-100',
    points: ['问 AI 补货/清滞销', '拍照识别进货单', '语音/唤醒词开单'],
  },
]

export function OnboardingPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [resetDone, setResetDone] = useState(false)

  // 清空演示数据：先备份再清空（失败不阻断），完成后进下一步
  const handleReset = async () => {
    setBusy(true)
    try {
      if (backend) {
        const r = await backend.invoke('onboarding:reset')
        if (!r?.ok) throw new Error(r?.error || '清空失败')
      }
      setResetDone(true)
      setTimeout(() => setStep((s) => s + 1), 700)
    } catch {
      setResetDone(true)
      setTimeout(() => setStep((s) => s + 1), 700)
    } finally {
      setBusy(false)
    }
  }

  // 完成引导并前往某页（去注册/开单/体验时也视为已完成，避免下次启动再弹）
  const finishAndGo = async (to: string) => {
    if (backend) {
      try { await backend.invoke('onboarding:finish') } catch { /* 不重要 */ }
    }
    navigate(to)
  }

  const stepData = STEPS[step]
  const isLast = step === STEPS.length - 1

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-[#e8eef6] to-[#dbe7f3] px-4">
      <div className="w-full max-w-md">
        {/* 品牌 + 一句话口号 */}
        <div className="mb-6 text-center">
          <div className="text-lg font-bold text-[#16355c]">AI 智能进销存</div>
          <div className="mt-1 text-xs text-slate-500">10 分钟上手 · 卖货/管货/AI 帮手</div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -18 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <Card className="border-slate-200/60 shadow-[0_20px_60px_-20px_rgba(22,53,92,0.3)]">
              <CardContent className="space-y-5 pt-8 pb-6">
                {/* 步骤指示器 */}
                <div className="flex items-center justify-center gap-2">
                  {STEPS.map((_, i) => (
                    <div
                      key={i}
                      className={`h-2 w-2 rounded-full transition-all ${
                        i === step ? 'w-5 bg-brand-600' : i < step ? 'bg-green-500' : 'bg-slate-300'
                      }`}
                    />
                  ))}
                </div>

                {/* 主体 */}
                <div className="flex flex-col items-center text-center">
                  <div className={`mb-4 rounded-full p-4 ${stepData.iconBg}`}>
                    <stepData.icon className={`size-8 ${stepData.iconColor}`} />
                  </div>
                  <h2 className="text-lg font-bold text-slate-800">{stepData.title}</h2>
                  <div className="mt-0.5 text-xs font-medium text-brand-600">{stepData.sub}</div>
                  <p className="mt-2 text-sm leading-relaxed text-slate-500">{stepData.desc}</p>
                </div>

                {/* 3 点要点 */}
                <div className="mx-auto grid max-w-xs grid-cols-1 gap-1.5">
                  {stepData.points.map((p) => (
                    <div key={p} className="flex items-center gap-2 text-left text-[13px] text-slate-600">
                      <CheckCircle className="size-4 shrink-0 text-green-500" />
                      <span>{p}</span>
                    </div>
                  ))}
                </div>

                {/* 各步动作 */}
                {step === 0 && (
                  <div className="flex flex-col gap-2">
                    {!resetDone ? (
                      <Button onClick={handleReset} disabled={busy} className="w-full">
                        {busy ? '正在备份并清空演示数据...' : '清空演示数据，正式开张'}
                      </Button>
                    ) : (
                      <div className="rounded-lg bg-green-50 px-4 py-3 text-center text-sm font-medium text-green-700">
                        演示数据已清空，可以录入真实库存了
                      </div>
                    )}
                    <button
                      onClick={() => { setResetDone(true); setStep(1) }}
                      className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
                    >
                      {resetDone ? '继续' : '先保留演示数据，稍后再说'}
                    </button>
                  </div>
                )}

                {step === 1 && (
                  <div className="flex flex-col gap-2">
                    <Button onClick={() => void finishAndGo('/account')} className="w-full">
                      去注册云账号 <ArrowRight className="size-4" />
                    </Button>
                    <button
                      onClick={() => setStep(2)}
                      className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
                    >
                      暂不注册，用本地模式先继续
                    </button>
                  </div>
                )}

                {step === 2 && (
                  <div className="flex flex-col gap-2">
                    <Button onClick={() => void finishAndGo('/outbound')} className="w-full">
                      去开单体验 <ArrowRight className="size-4" />
                    </Button>
                    <button
                      onClick={() => setStep(3)}
                      className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
                    >
                      看步骤就够了，继续
                    </button>
                  </div>
                )}

                {step === 3 && (
                  <Button onClick={() => void finishAndGo('/')} className="w-full">
                    开始用系统 <ArrowRight className="size-4" />
                  </Button>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </AnimatePresence>

        {/* 底部导航：上一步 / 跳过整段引导 */}
        <div className="mt-5 flex items-center justify-between">
          {step > 0 ? (
            <button
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
            >
              上一步
            </button>
          ) : (
            <span />
          )}
          {isLast ? (
            <span />
          ) : (
            <button
              onClick={() => setStep((s) => s + 1)}
              className="text-sm font-medium text-brand-600 hover:text-brand-700 cursor-pointer"
            >
              下一步
            </button>
          )}
        </div>
        <div className="mt-3 text-center">
          <button
            onClick={() => void finishAndGo('/')}
            className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
          >
            跳过引导，直接进入系统
          </button>
        </div>
      </div>
    </div>
  )
}
