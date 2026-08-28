// 唤醒词监听（实验，默认关闭）：常驻麦克风 → 重采样 16kHz → PCM 小块经 IPC 推给主进程 KWS。
// 检出「小杜小杜」→ 提示音 + 跳回仪表盘 + 派发 fi:wake 事件（AiPanel 收到后自动开始录音）。
// 开关持久化 localStorage（key 'fi-wake'），默认关；开启才申请麦克风常驻权限。
// 任何环节失败（无后端、模型未下载、麦克风被拒）都返回大白话 reason，调用方决定怎么提示。
import { backend } from '@/lib/api'
import { playSound } from '@/lib/sounds'

const LS_WAKE = 'fi-wake'

export function readWakeEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(LS_WAKE) === 'on'
  } catch {
    return false
  }
}

export function writeWakeEnabled(on: boolean): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(LS_WAKE, on ? 'on' : 'off')
  } catch {
    // 写不进去就算了，设置只在本次会话生效
  }
}

// AiPanel 还没挂载（如在设置页）时先记一笔，挂载后取走；保证唤醒不丢
let pendingWake = false
export function consumePendingWake(): boolean {
  const p = pendingWake
  pendingWake = false
  return p
}

let stream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let running = false
// kws:push 必须按音频顺序到达主进程（单条流式状态机），一帧在飞就丢新帧：
// KWS 对偶尔丢 85ms 小帧不敏感，乱序喂帧才会把模型状态搞乱
let pushInFlight = false

/** 把 AudioContext 采样率（通常 48k）的帧线性重采样到 16kHz */
function downsampleTo16k(input: Float32Array, srcRate: number): Float32Array {
  if (srcRate === 16000) return input
  const ratio = srcRate / 16000
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const lo = Math.floor(pos)
    const frac = pos - lo
    out[i] = input[lo] * (1 - frac) + (input[Math.min(lo + 1, input.length - 1)] ?? 0) * frac
  }
  return out
}

function onWakeDetected(): void {
  playSound('scan')
  // 不在仪表盘时先跳回去（唤醒的意图就是跟 AI 说话），再派发事件
  if (window.location.hash !== '' && window.location.hash !== '#/') {
    pendingWake = true
    window.location.hash = '#/'
  }
  window.dispatchEvent(new CustomEvent('fi:wake'))
}

/** 开启常驻监听。已开着直接返回；失败返回 { ok:false, reason } */
export async function startWakeListener(): Promise<{ ok: boolean; reason?: string }> {
  if (running) return { ok: true }
  if (!backend) return { ok: false, reason: '唤醒词功能需要桌面版' }
  try {
    const s = await backend.invoke('kws:status')
    if (!s?.ready) return { ok: false, reason: '唤醒词模型还没下载，先点上方下载' }
  } catch {
    return { ok: false, reason: '唤醒词功能暂时不可用' }
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    audioCtx = new AudioContext()
    const src = audioCtx.createMediaStreamSource(stream)
    const proc = audioCtx.createScriptProcessor(4096, 1, 1)
    const rate = audioCtx.sampleRate
    proc.onaudioprocess = (e) => {
      if (pushInFlight || !backend) return
      const pcm = downsampleTo16k(e.inputBuffer.getChannelData(0), rate)
      pushInFlight = true
      backend
        .invoke('kws:push', { pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) })
        .then((r) => {
          if (r?.detected) onWakeDetected()
        })
        .catch(() => {})
        .finally(() => {
          pushInFlight = false
        })
    }
    // ScriptProcessor 必须接到 destination 才回调；中间过 0 增益，避免麦克风原声外放
    const mute = audioCtx.createGain()
    mute.gain.value = 0
    src.connect(proc)
    proc.connect(mute)
    mute.connect(audioCtx.destination)
    running = true
    return { ok: true }
  } catch {
    stopWakeListener()
    return { ok: false, reason: '用不了麦克风：请检查麦克风是否插好，或系统设置里允许本软件使用麦克风' }
  }
}

/** 关闭常驻监听，释放麦克风（系统托盘mic指示灯随之熄灭） */
export function stopWakeListener(): void {
  running = false
  try {
    stream?.getTracks().forEach((t) => t.stop())
    void audioCtx?.close().catch(() => {})
  } catch {
    // 静默
  }
  stream = null
  audioCtx = null
  pushInFlight = false
}

export function isWakeListenerRunning(): boolean {
  return running
}
