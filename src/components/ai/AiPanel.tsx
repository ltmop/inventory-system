// AI 问答面板：老板直接用大白话问店里的事
// 只在 Electron 且已配置 Key 时渲染；问答数字全部来自本地 SQLite 工具查询
// 入库/出库由 AI 生成草稿卡，人点确认后才走既有 store action 落库
import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic, PackagePlus, PackageMinus, Send, Sparkles, Volume2, VolumeX } from 'lucide-react'
import { motion } from 'motion/react'
import { backend } from '@/lib/api'
import { blobToBase64, blobToPcm16k } from '@/lib/audio'
import { useVoiceModel } from '@/lib/useModelDownload'
import { consumePendingWake } from '@/lib/wakeWord'
import { readTtsEnabled, speak, stopSpeaking, writeTtsEnabled } from '@/lib/tts'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

interface Draft {
  kind: 'inbound' | 'outbound'
  product_id: number
  product_name: string
  sku_code: string
  quantity: number
  cost_price_fen?: number
  cost_price_yuan?: number
  selling_price_fen?: number
  selling_price_yuan?: number
  location?: string | null
  current_stock?: number
  state: 'pending' | 'busy' | 'done' | 'failed'
  error?: string
}

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  drafts?: Draft[]
  trace?: string[]
}

const TOOL_LABEL: Record<string, string> = {
  query_product: '商品查找',
  stock_of: '库存明细',
  daily_summary: '经营汇总',
  top_products: '销量排行',
  low_stock_list: '低库存清单',
  slow_moving_list: '滞销清单',
  draft_inbound: '入库草稿',
  draft_outbound: '出库草稿',
}

const SUGGESTIONS = [
  '今天赚了多少钱？',
  '哪些货该补了？',
  '最近7天什么卖得最好？',
  '有没有滞销品？',
  '赤刃还剩几条？',
]

export function AiPanel() {
  const addInbound = useAppStore((s) => s.addInbound)
  const confirmOutbound = useAppStore((s) => s.confirmOutbound)

  const [enabled, setEnabled] = useState(false)
  const [providerName, setProviderName] = useState('AI')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 语音助手：按住说话（ASR）+ 答复播报（TTS）
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [micBlocked, setMicBlocked] = useState(false)
  const [voiceUsed, setVoiceUsed] = useState(false)
  const [ttsOn, setTtsOn] = useState(readTtsEnabled)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cardRef = useRef<HTMLDivElement>(null)
  // 唤醒词触发的自动录音：5 秒自动停止的定时器（手动停录时清掉）
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 语音模型：就绪走本地离线识别（voice:transcribe），未下载回退云端（ai:transcribe）
  const {
    ready: voiceReady,
    downloading: voiceDownloading,
    percent: voicePercent,
    error: voiceDlError,
    startDownload: startVoiceDownload,
  } = useVoiceModel()

  // 卸载时停掉正在播的语音和没结束的录音
  useEffect(() => {
    return () => {
      stopSpeaking()
      if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current)
      const r = recorderRef.current
      if (r && r.state !== 'inactive') r.stop()
    }
  }, [])

  // 唤醒词「小杜小杜」：收到 fi:wake（或挂载时取到待处理唤醒）→ 滚动到面板
  // → 先播一句"在"回应，等它说完再开始录音听问题（老板听到"在"就知道该开口了）
  useEffect(() => {
    const onWake = () => {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // AI 未激活（无 Key）时面板只展示，录音函数未定义，直接跳过
      if (!backend || !enabled || recording || thinking || transcribing || micBlocked) return
      // 先回"在"，播完（约 1.2 秒）再自动录音 5 秒听问题
      speak('在')
      if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current)
      wakeTimerRef.current = setTimeout(() => {
        wakeTimerRef.current = null
        if (recording || thinking || transcribing) return
        void startRecording()
        const t = setTimeout(() => {
          wakeTimerRef.current = null
          stopRecording()
        }, 5000)
        wakeTimerRef.current = t
      }, 1200)
    }
    window.addEventListener('fi:wake', onWake)
    if (consumePendingWake()) onWake()
    return () => window.removeEventListener('fi:wake', onWake)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, thinking, transcribing, micBlocked])

  useEffect(() => {
    if (!backend) return
    backend
      .invoke('ai:status')
      .then((s) => {
        setEnabled(!!s?.configured)
        if (typeof s?.provider === 'string' && s.provider) setProviderName(s.provider)
      })
      .catch(() => {})
    // 启动恢复历史对话（ai_messages 表，只含 user/assistant）；失败静默保持空面板
    backend
      .invoke('ai:history', { limit: 50 })
      .then((rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return
        setMessages(
          rows
            .filter((r) => r?.role === 'user' || r?.role === 'assistant')
            .map((r) => ({ role: r.role as 'user' | 'assistant', content: String(r.content ?? '') })),
        )
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, thinking])

  // v0.1 起内置官方 AI 服务（默认可用），面板不再因没配 Key 隐藏——卖点必须看得见
  if (!backend) return null
  // guard 之后的非空别名（TS 闭包窄化限制）
  const fi = backend

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || thinking) return
    setInput('')
    const history = [...messages, { role: 'user' as const, content: q }]
    setMessages(history)
    setThinking(true)
    try {
      const r = await fi.invoke('ai:chat', {
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      })
      if (r?.ok) {
        setMessages([
          ...history,
          {
            role: 'assistant',
            content: r.content,
            drafts: (r.drafts ?? []).map((d: Omit<Draft, 'state'>) => ({ ...d, state: 'pending' as const })),
            trace: r.trace,
          },
        ])
        // 语音播报开关开着时，把最终答复读出来（tool 中间步骤不进 messages，天然不播）
        if (ttsOn) speak(r.content)
      } else {
        const reason =
          r?.reason === 'timeout' ? 'AI 响应超时，请再试一次'
          : r?.reason?.startsWith('http-4') ? 'API Key 可能失效或余额不足，请到设置页检查'
          : 'AI 暂时不可用，请稍后再试（网络或额度问题）'
        setMessages([...history, { role: 'assistant', content: reason }])
      }
    } catch {
      setMessages([...history, { role: 'assistant', content: 'AI 调用失败，请检查网络后重试' }])
    } finally {
      setThinking(false)
    }
  }

  // 按住说话：pointerdown 开录，pointerup 停录 → base64 → ai:transcribe → 识别文字
  // 作为一条 user 消息直接走现有发送流程（老板能在消息列表里看到识别成了什么，
  // 识别错了能发现；写操作仍由 Agent 的草稿确认卡兜底，语音不会绕过确认直接落库）
  const startRecording = async () => {
    if (!backend || recording || thinking || transcribing || micBlocked) return
    setVoiceError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(
        stream,
        MediaRecorder.isTypeSupported('audio/webm') ? { mimeType: 'audio/webm' } : undefined,
      )
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        void recognize(blob)
      }
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch {
      // 无麦克风 / 权限被拒：按钮置灰，用大白话告诉老板去哪查
      setMicBlocked(true)
      setVoiceError('用不了麦克风：请检查麦克风是否插好，或系统设置里允许本软件使用麦克风')
    }
  }

  const stopRecording = () => {
    if (wakeTimerRef.current) {
      clearTimeout(wakeTimerRef.current)
      wakeTimerRef.current = null
    }
    const r = recorderRef.current
    if (r && r.state !== 'inactive') r.stop()
    recorderRef.current = null
    setRecording(false)
  }

  const recognize = async (blob: Blob) => {
    if (!backend) return
    if (blob.size === 0) {
      setVoiceError('没听清，请再说一次')
      return
    }
    setTranscribing(true)
    try {
      let r
      if (voiceReady) {
        // 本地离线识别：webm → 16kHz 单声道 PCM → voice:transcribe（断网也能用）
        const pcm = await blobToPcm16k(blob)
        r = await backend.invoke('voice:transcribe', {
          pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
          sampleRate: 16000,
        })
      } else {
        // 模型未下载：回退原有云端识别链路（base64 webm）
        const audioBase64 = await blobToBase64(blob)
        r = await backend.invoke('ai:transcribe', {
          audioBase64,
          mimeType: blob.type || 'audio/webm',
        })
      }
      if (r?.ok && typeof r.text === 'string' && r.text.trim()) {
        setVoiceUsed(true)
        await send(r.text.trim())
      } else {
        // 本地通道的错误本身就是大白话，直接展示；云端错误码统一归为"没听清"
        const reason = typeof r?.reason === 'string' && /[一-龥]/.test(r.reason) ? r.reason : '没听清，请再说一次'
        setVoiceError(reason)
      }
    } catch {
      setVoiceError('没听清，请再说一次')
    } finally {
      setTranscribing(false)
    }
  }

  const toggleTts = () => {
    const next = !ttsOn
    setTtsOn(next)
    writeTtsEnabled(next)
    if (!next) stopSpeaking()
  }

  const patchDraft = (msgIdx: number, draftIdx: number, fields: Partial<Draft>) =>
    setMessages((prev) =>
      prev.map((m, i) =>
        i !== msgIdx
          ? m
          : { ...m, drafts: m.drafts?.map((d, j) => (j === draftIdx ? { ...d, ...fields } : d)) },
      ),
    )

  const confirmDraft = async (msgIdx: number, draftIdx: number) => {
    const msg = messages[msgIdx]
    const draft = msg.drafts?.[draftIdx]
    if (!draft || draft.state !== 'pending') return

    const patch = (state: Draft['state']) =>
      setMessages((prev) =>
        prev.map((m, i) =>
          i !== msgIdx
            ? m
            : { ...m, drafts: m.drafts?.map((d, j) => (j === draftIdx ? { ...d, state } : d)) },
        ),
      )
    if (draft.kind === 'inbound') {
      // 进价必填且 >0（与入库页、导入校验同口径）：缺进价不记账，
      // 保持 pending 状态并在草稿卡上红字提示，让老板补填后再确认
      const raw = draft.cost_price_fen
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
        patchDraft(msgIdx, draftIdx, { error: `第 ${draftIdx + 1} 项缺少进价，请补填后再入账` })
        return
      }
    }
    patch('busy')
    try {
      if (draft.kind === 'inbound') {
        const cost = draft.cost_price_fen as number
        if (!Number.isInteger(draft.quantity) || draft.quantity <= 0) {
          patch('failed')
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: `这张草稿数量无效（${draft.product_name}），请重新生成。` },
          ])
          return
        }
        await addInbound({
          productId: draft.product_id,
          quantity: draft.quantity,
          costPrice: cost,
          location: draft.location ?? null,
          supplierId: null,
          operator: 'AI助手',
        })
      } else {
        // 售价必填且 >0（与出库页同口径）：AI 没识别到售价时不记账，让老板补上
        const selling = draft.selling_price_fen
        if (typeof selling !== 'number' || !Number.isFinite(selling) || selling <= 0) {
          patch('failed')
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: `这张出库草稿缺售价（${draft.product_name}），没售价就没法算营业额和毛利。请告诉我卖多少钱，例如「${draft.product_name} 卖 85 元，出库 ${draft.quantity} 件」。`,
            },
          ])
          return
        }
        const r = await confirmOutbound(
          draft.product_id,
          draft.quantity,
          selling,
          'AI助手',
        )
        if (!r.ok) {
          patch('failed')
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: `出库没成功：${draft.product_name}${'shortage' in r ? ` 库存不足，还差 ${r.shortage} 件` : r.expired ? ' 含已过期批次' : ''}。` },
          ])
          return
        }
      }
      patch('done')
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `已记账：${draft.product_name} ${draft.kind === 'inbound' ? '入库' : '出库'} ${draft.quantity} 件。库存和报表已更新。`,
        },
      ])
    } catch (e) {
      patch('failed')
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `操作失败：${e instanceof Error ? e.message : String(e)}` },
      ])
    }
  }

  return (
    <div ref={cardRef} className="scroll-mt-4">
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-5 text-brand-500" />
          AI 助手 · 直接问店里的事
          <span className="text-xs font-normal text-muted-foreground">由{providerName}生成，数字来自本地库存记录</span>
          {/* 语音播报开关（与设置页共享 localStorage 'fi-tts'） */}
          <button
            type="button"
            onClick={toggleTts}
            title={ttsOn ? '关闭语音播报' : '开启语音播报'}
            aria-pressed={ttsOn}
            className="ml-auto rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            {ttsOn ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 消息区 */}
        {messages.length === 0 && !thinking ? (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm text-brand-700 transition-colors hover:bg-brand-100"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          <div ref={scrollRef} className="max-h-96 space-y-3 overflow-auto rounded-lg bg-slate-50 p-4">
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
                <div
                  className={`inline-block max-w-[85%] rounded-2xl px-4 py-2.5 text-left text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-brand-600 text-white'
                      : 'bg-white text-slate-800 shadow-sm'
                  }`}
                >
                  {m.content}
                  {m.trace && m.trace.length > 0 && (
                    <div className="mt-1.5 text-xs text-slate-400">
                      已查询：{[...new Set(m.trace)].map((t) => TOOL_LABEL[t] ?? t).join('、')}
                    </div>
                  )}
                </div>
                {/* 草稿确认卡 */}
                {m.drafts?.map((d, j) => (
                  <div
                    key={j}
                    className="mt-2 inline-flex max-w-[85%] items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-left"
                  >
                    {d.kind === 'inbound' ? (
                      <PackagePlus className="size-5 shrink-0 text-amber-600" />
                    ) : (
                      <PackageMinus className="size-5 shrink-0 text-amber-600" />
                    )}
                    <div className="text-sm">
                      <div className="font-medium text-slate-800">
                        {d.kind === 'inbound' ? '入库' : '出库'}草稿：{d.product_name} × {d.quantity}
                      </div>
                      <div className="text-xs text-slate-500">
                        {d.kind === 'inbound' ? (
                          <span className="flex items-center gap-1">
                            进价
                            {d.state === 'pending' ? (
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={d.cost_price_yuan ?? ''}
                                onChange={(e) => {
                                  const yuan = e.target.value === '' ? undefined : Number(e.target.value)
                                  patchDraft(i, j, {
                                    cost_price_yuan: yuan,
                                    cost_price_fen:
                                      typeof yuan === 'number' && Number.isFinite(yuan)
                                        ? Math.round(yuan * 100)
                                        : undefined,
                                    error: undefined,
                                  })
                                }}
                                placeholder="必填"
                                className="h-6 w-20 px-1 text-xs"
                              />
                            ) : (
                              ` ${d.cost_price_yuan ?? '-'} 元`
                            )}
                            {d.location ? ` · 货位 ${d.location}` : ''}
                          </span>
                        ) : (
                          `售价 ${d.selling_price_yuan ?? '-'} 元 · 当前库存 ${d.current_stock} 件`
                        )}
                        {d.error && <div className="mt-0.5 text-red-500">{d.error}</div>}
                      </div>
                    </div>
                    {d.state === 'pending' && (
                      <Button size="sm" onClick={() => confirmDraft(i, j)}>
                        确认{d.kind === 'inbound' ? '入库' : '出库'}
                      </Button>
                    )}
                    {d.state === 'busy' && <Loader2 className="size-4 animate-spin text-amber-600" />}
                    {d.state === 'done' && <span className="text-sm font-medium text-green-600">✓ 已记账</span>}
                    {d.state === 'failed' && <span className="text-sm text-red-500">✗ 未完成</span>}
                  </div>
                ))}
              </div>
            ))}
            {thinking && (
              <div className="inline-flex items-center gap-2 rounded-2xl bg-white px-4 py-2.5 text-sm text-slate-500 shadow-sm">
                <Loader2 className="size-4 animate-spin" />
                AI 正在查库存记录…
              </div>
            )}
          </div>
        )}

        {/* 语音识别状态提示：识别中 / 没听清（红条风格与设置页一致） */}
        {transcribing && (
          <div className="rounded-lg bg-brand-50 px-4 py-3 text-sm text-brand-700">
            正在识别你说的话…
          </div>
        )}
        {voiceError && !transcribing && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{voiceError}</div>
        )}

        {/* 语音模型未下载：提示下载（约78MB），下载后离线也能识别；下载中显示进度条 */}
        {voiceReady === false && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
            {voiceDownloading ? (
              <div className="flex items-center gap-3">
                <Loader2 className="size-4 shrink-0 animate-spin" />
                <span className="flex-1">正在下载语音识别模型… {voicePercent}%</span>
                <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-amber-200">
                  <div className="h-full bg-amber-500 transition-all" style={{ width: `${voicePercent}%` }} />
                </div>
              </div>
            ) : (
              <button type="button" onClick={startVoiceDownload} className="block w-full text-left hover:underline">
                语音识别模型未下载（约78MB），点此处下载，下好后没网也能用
              </button>
            )}
          </div>
        )}
        {voiceDlError && !voiceDownloading && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{voiceDlError}</div>
        )}

        {/* 输入区 */}
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send(input)}
            placeholder="问点什么，比如：YGK 还剩几卷 / 这周赚了多少钱"
            disabled={thinking}
          />
          {/* 按住说话：按下开录（红色脉冲），松开发送；无麦克风/浏览器 dev 模式置灰 */}
          <motion.button
            type="button"
            onPointerDown={startRecording}
            onPointerUp={stopRecording}
            onPointerLeave={() => recording && stopRecording()}
            onPointerCancel={stopRecording}
            onContextMenu={(e) => e.preventDefault()}
            disabled={!backend || micBlocked || thinking || transcribing}
            animate={recording ? { scale: [1, 1.15, 1] } : { scale: 1 }}
            transition={recording ? { duration: 0.9, repeat: Infinity } : { duration: 0.15 }}
            title={
              !backend
                ? '语音功能需要桌面版'
                : micBlocked
                  ? '麦克风不可用'
                  : voiceReady
                    ? '离线识别：按住说话，松开发送'
                    : '按住说话，松开发送（在线识别）'
            }
            className={`flex size-10 shrink-0 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50 ${
              recording
                ? 'bg-red-500 text-white'
                : 'border border-input bg-background text-slate-600 hover:bg-accent'
            }`}
          >
            <Mic className="size-4" />
          </motion.button>
          <Button onClick={() => send(input)} disabled={thinking || !input.trim()}>
            <Send className="size-4" />
          </Button>
        </div>
        {/* 首次使用提示：用过一次语音后就不再显示 */}
        {!voiceUsed && (
          <p className="text-xs text-muted-foreground">按住麦克风说话，松开发送</p>
        )}
      </CardContent>
    </Card>
    </div>
  )
}
