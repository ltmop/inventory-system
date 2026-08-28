// 语音播报 TTS：桌面版且「语音合成模型」就绪时优先走 sherpa-onnx 离线合成（主进程合成 wav，
// 这里用 Audio 播放）；其余情况（浏览器 dev、模型未下载、合成失败）回退 speechSynthesis 系统语音。
// 与 sounds.ts 同一思路：只是反馈层，任何环境失败都静默，绝不影响业务操作。
// 开关持久化在 localStorage（key 'fi-tts'），AiPanel 头部开关与设置页共享这一份。
import { backend } from '@/lib/api'

const LS_TTS = 'fi-tts'
const LS_TTS_SPEAKER = 'fi-tts-speaker'

/** 语音播报开关，默认开；读写都包 try/catch（隐私模式退回默认值） */
export function readTtsEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem(LS_TTS) !== 'off'
  } catch {
    return true
  }
}

export function writeTtsEnabled(on: boolean): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(LS_TTS, on ? 'on' : 'off')
  } catch {
    // 写不进去就算了，设置只在本次会话生效
  }
}

/** 小杜音色：固定一个女性声线（aishell3 模型里的一个女声说话人）。老板不用选，就是它。 */
export const DU_XIAO_DU_SPEAKER = 3

/** 小杜的音色（固定女性声线）；读偏好，没存过用默认女性音色 */
export function readTtsSpeaker(): number {
  try {
    if (typeof window === 'undefined') return DU_XIAO_DU_SPEAKER
    const v = Number(window.localStorage.getItem(LS_TTS_SPEAKER))
    return Number.isInteger(v) && v >= 0 && v < 174 ? v : DU_XIAO_DU_SPEAKER
  } catch {
    return DU_XIAO_DU_SPEAKER
  }
}

export function writeTtsSpeaker(sid: number): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(LS_TTS_SPEAKER, String(Math.max(0, Math.min(173, Math.round(sid)))))
  } catch {
    // 写不进去就算了
  }
}

/** 从系统语音列表里挑中文语音：优先 zh-CN，其次任意 zh-*；没有就返回 null（用系统默认语音） */
export function pickChineseVoice<T extends { lang: string }>(voices: T[]): T | null {
  const zh = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith('zh'))
  if (zh.length === 0) return null
  return zh.find((v) => v.lang.toLowerCase().replace('_', '-') === 'zh-cn') ?? zh[0]
}

// ---------- sherpa 离线合成（桌面版专属，模型就绪才启用） ----------

// 引擎就绪状态缓存：null=还没查过（首次播报时查一次）；true/false 查到后的结果。
// 设置页下载完成后经 setSherpaTtsReady 直接置 true，不用等下次查询。
let sherpaReady: boolean | null = null
let sherpaReadyPromise: Promise<boolean> | null = null
// 正在播放的 Audio 元素（stopSpeaking 用）
let currentAudio: HTMLAudioElement | null = null
let currentUrl: string | null = null

/** 设置页/下载流程回写引擎状态（下载完成置 true，避免下次播报前多一次查询） */
export function setSherpaTtsReady(ready: boolean): void {
  sherpaReady = ready
}

/** 查询主进程 TTS 模型是否就绪（带缓存；查询失败按未就绪处理，自动回退系统语音） */
function ensureSherpaReady(): Promise<boolean> {
  if (sherpaReady !== null) return Promise.resolve(sherpaReady)
  if (sherpaReadyPromise) return sherpaReadyPromise
  if (!backend) {
    sherpaReady = false
    return Promise.resolve(false)
  }
  sherpaReadyPromise = backend
    .invoke('tts:status')
    .then((s) => {
      sherpaReady = !!s?.ready
      return sherpaReady
    })
    .catch(() => {
      sherpaReady = false
      return false
    })
    .finally(() => {
      sherpaReadyPromise = null
    })
  return sherpaReadyPromise
}

/** sherpa 合成 + 播放；任何一步失败返回 false，调用方回退系统语音 */
async function speakViaSherpa(content: string): Promise<boolean> {
  try {
    if (!backend) return false
    // 用老板选的小杜音色（sid），没选过默认 0
    const r = await backend.invoke('tts:speak', { text: content, sid: readTtsSpeaker() })
    if (!r?.ok || !(r.wav instanceof Uint8Array) || r.wav.length === 0) return false
    stopCurrentAudio()
    const copy = new Uint8Array(r.wav) // 拷贝一份，Blob 不引用 IPC 缓冲
    const url = URL.createObjectURL(new Blob([copy], { type: 'audio/wav' }))
    const audio = new Audio(url)
    currentAudio = audio
    currentUrl = url
    audio.onended = audio.onerror = () => {
      if (currentAudio === audio) {
        currentAudio = null
        currentUrl = null
      }
      URL.revokeObjectURL(url)
    }
    await audio.play()
    return true
  } catch {
    return false
  }
}

function stopCurrentAudio(): void {
  try {
    currentAudio?.pause()
    if (currentUrl) URL.revokeObjectURL(currentUrl)
  } catch {
    // 静默
  }
  currentAudio = null
  currentUrl = null
}

/** 系统语音播报（回退路径）：优先中文语音，语速略快（1.05） */
function speakViaSystem(content: string): void {
  try {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(content)
    utter.lang = 'zh-CN'
    utter.rate = 1.05
    const voice = pickChineseVoice(window.speechSynthesis.getVoices())
    if (voice) utter.voice = voice
    window.speechSynthesis.speak(utter)
  } catch {
    // 播报失败（如系统无语音包）不影响对话本身
  }
}

/** 播报一段文字（会先掐掉正在播的）。开关关掉时静默。sherpa 失败自动回退系统语音 */
export function speak(text: string): void {
  try {
    if (!readTtsEnabled()) return
    const content = text.trim()
    if (!content) return
    stopCurrentAudio()
    void ensureSherpaReady().then(async (ready) => {
      // 等状态期间开关被关掉就不播了
      if (!readTtsEnabled()) return
      if (ready && (await speakViaSherpa(content))) return
      speakViaSystem(content)
    })
  } catch {
    // 播报只是反馈层，失败不影响对话本身
  }
}

/** 停止当前播报（组件卸载、老板点关闭开关时调用） */
export function stopSpeaking(): void {
  stopCurrentAudio()
  try {
    if (typeof window === 'undefined' || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
  } catch {
    // 同上，静默
  }
}
