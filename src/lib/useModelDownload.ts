// 语音类模型下载状态共享 hook：ASR（语音识别）/ TTS（语音合成）/ KWS（唤醒词）三个模型
// 同一套 状态查询 → 下载 → 进度订阅 流程，只是通道名不同，这里抽公共实现。
// ready: null=查询中 / true=模型已下好 / false=未下载
import { useCallback, useEffect, useRef, useState } from 'react'
import { backend, type VoiceProgress } from '@/lib/api'
import { setSherpaTtsReady } from '@/lib/tts'

interface ModelChannelSpec {
  statusChannel: string
  downloadChannel: string
  /** preload 暴露的进度订阅方法名（onVoiceProgress / onTtsProgress / onKwsProgress） */
  progressSubscriber: 'onVoiceProgress' | 'onTtsProgress' | 'onKwsProgress'
  /** 下载成功后的副作用（如 TTS 回写播报引擎缓存） */
  onReady?: () => void
}

export function useModelDownload({ statusChannel, downloadChannel, progressSubscriber, onReady }: ModelChannelSpec) {
  const [ready, setReady] = useState<boolean | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useEffect(() => {
    if (!backend) {
      setReady(false)
      return
    }
    backend
      .invoke(statusChannel)
      .then((s) => {
        setReady(!!s?.ready)
        if (s?.downloading) setDownloading(true)
      })
      .catch(() => setReady(false))
    return () => {
      unsubRef.current?.()
      unsubRef.current = null
    }
  }, [statusChannel])

  const startDownload = useCallback(async () => {
    if (!backend || downloading) return
    setDownloading(true)
    setError(null)
    setPercent(0)
    unsubRef.current?.()
    unsubRef.current = backend[progressSubscriber]?.((p: VoiceProgress) => setPercent(p.percent)) ?? null
    try {
      const r = await backend.invoke(downloadChannel)
      if (r?.ok) {
        setReady(true)
        setPercent(100)
        onReadyRef.current?.()
      } else {
        setError(typeof r?.reason === 'string' ? r.reason : '模型下载失败，请稍后重试')
      }
    } catch {
      setError('模型下载失败，请检查网络后重试')
    } finally {
      setDownloading(false)
      unsubRef.current?.()
      unsubRef.current = null
    }
  }, [downloading, downloadChannel, progressSubscriber])

  return { ready, downloading, percent, error, startDownload }
}

/** 语音识别模型（阿里 SenseVoiceSmall int8，约228MB，sherpa-onnx 加载） */
export function useVoiceModel() {
  return useModelDownload({
    statusChannel: 'voice:status',
    downloadChannel: 'voice:download',
    progressSubscriber: 'onVoiceProgress',
  })
}

/** 语音合成模型（sherpa-onnx vits-zh-aishell3 int8，约42MB）；下载成功回写播报引擎缓存 */
export function useTtsModel() {
  return useModelDownload({
    statusChannel: 'tts:status',
    downloadChannel: 'tts:download',
    progressSubscriber: 'onTtsProgress',
    onReady: () => setSherpaTtsReady(true),
  })
}

/** 唤醒词模型（sherpa-onnx kws-zipformer-wenetspeech 3.3M，约5MB） */
export function useKwsModel() {
  return useModelDownload({
    statusChannel: 'kws:status',
    downloadChannel: 'kws:download',
    progressSubscriber: 'onKwsProgress',
  })
}
