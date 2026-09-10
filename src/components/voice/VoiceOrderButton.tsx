// P1-3 语音开单按钮：按住说话 → 离线识别（免费）→ 本地匹配 → 未命中才走 LLM（收费）
// 降级铁律：402/断网/识别失败 → 识别文本回填搜索框（onFallbackText），不白识别、不出确认卡。
// 复用 VoiceSearchButton 同一条录音链路（webm → 16kHz PCM）；模型没下载时云端 ASR 兜底出文本。
import { useRef, useState } from 'react'
import { Mic, Loader2 } from 'lucide-react'
import { useVoiceModel } from '@/lib/useModelDownload'
import { blobToPcm16k, blobToBase64 } from '@/lib/audio'
import { backend } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { VoiceOrderResult } from './VoiceOrderConfirmCard'

interface VoiceOrderButtonProps {
  /** 解析出开单草稿 → 弹确认卡 */
  onDraft: (r: VoiceOrderResult) => void
  /** 402/断网等降级：识别文本回填搜索框，手动开单 */
  onFallbackText: (text: string) => void
  className?: string
}

export function VoiceOrderButton({ onDraft, onFallbackText, className }: VoiceOrderButtonProps) {
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const { ready: voiceReady } = useVoiceModel()

  const stopRec = () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') recorderRef.current.stop()
  }

  const startRec = async () => {
    if (busy || !backend) return
    const be = backend
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
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        setRecording(false)
        if (blob.size === 0) return
        setBusy(true)
        try {
          let r: VoiceOrderResult | undefined | null
          if (voiceReady) {
            // 本地离线识别 + 解析一条龙（音频不出本机）
            const pcm = await blobToPcm16k(blob)
            r = await be.invoke('voice:parseOrderAudio', {
              pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
              sampleRate: 16000,
            })
          } else {
            // 本地模型没下载：云端 ASR 只出文本，再本地解析
            const audioBase64 = await blobToBase64(blob)
            const asr = await be.invoke('ai:transcribe', { audioBase64, mimeType: blob.type || 'audio/webm' })
            if (asr?.ok && asr.text) r = await be.invoke('voice:parseOrder', { text: asr.text })
          }
          if (r?.ok && !r.degraded && r.items?.some((i) => i.productId != null || (i.candidates?.length ?? 0) > 0)) {
            onDraft(r)
          } else if (r?.text || (r as { ok?: boolean })?.ok) {
            // 降级：402 / 断网 / 全没匹配上 → 文本填搜索框手动开单
            const t = (r as VoiceOrderResult)?.text
            if (t) onFallbackText(t)
          }
        } catch {
          /* 静默，用户可再试或手输 */
        } finally {
          setBusy(false)
        }
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch {
      /* 麦克风不可用：静默 */
    }
  }

  return (
    <button
      type="button"
      onPointerDown={(e) => {
        e.preventDefault()
        void startRec()
      }}
      onPointerUp={stopRec}
      onPointerLeave={stopRec}
      title="按住说话开单（如：伊势尼6号钩拿两包，收了10现金）"
      className={cn(
        'cursor-pointer rounded-lg p-2 transition-colors',
        recording ? 'bg-red-100 text-red-600' : 'text-brand-600 hover:bg-brand-50',
        busy && 'opacity-60',
        className,
      )}
    >
      {busy ? <Loader2 className="size-5 animate-spin" /> : <Mic className="size-5" />}
    </button>
  )
}
