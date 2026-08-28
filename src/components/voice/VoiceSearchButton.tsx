// 语音搜索按钮（v3.0 全版本开放）：按住说话 → 本地离线识别（或云端回退）→ 文字填入搜索框。
// 复用 AiPanel 同一条录音/识别链路：webm → 16kHz PCM → voice:transcribe（模型就绪，断网可用）；
// 模型没下载回退 ai:transcribe（云端）。
import { useRef, useState } from 'react'
import { Mic, Loader2 } from 'lucide-react'
import { useVoiceModel } from '@/lib/useModelDownload'
import { blobToPcm16k, blobToBase64 } from '@/lib/audio'
import { backend } from '@/lib/api'
import { cn } from '@/lib/utils'

interface VoiceSearchButtonProps {
  /** 识别出文字后回调（调用方填入搜索框） */
  onText: (text: string) => void
  className?: string
}

export function VoiceSearchButton({ onText, className }: VoiceSearchButtonProps) {
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const { ready: voiceReady } = useVoiceModel()

  const stopRec = () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop()
    }
  }

  const startRec = async () => {
    if (busy) return
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
          let r
          if (voiceReady) {
            const pcm = await blobToPcm16k(blob)
            r = await backend?.invoke('voice:transcribe', {
              pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
              sampleRate: 16000,
            })
          } else {
            const audioBase64 = await blobToBase64(blob)
            r = await backend?.invoke('ai:transcribe', { audioBase64, mimeType: blob.type || 'audio/webm' })
          }
          if (r?.ok && typeof r.text === 'string' && r.text.trim()) onText(r.text.trim())
        } catch {
          /* 识别失败静默，用户可再试或手输 */
        } finally {
          setBusy(false)
        }
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch {
      /* 麦克风不可用（如无权限/非安全上下文）：静默，用户手输 */
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
      title="按住说话搜索商品（语音输入）"
      className={cn(
        'cursor-pointer rounded-lg p-2 text-slate-500 transition-colors',
        recording ? 'bg-red-100 text-red-600' : 'hover:bg-slate-100 hover:text-brand-600',
        busy && 'opacity-60',
        className,
      )}
    >
      {busy ? <Loader2 className="size-5 animate-spin" /> : <Mic className="size-5" />}
    </button>
  )
}
