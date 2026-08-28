// 操作提示音：全部用 Web Audio API（OscillatorNode）编程生成，不引入任何音频文件。
// 三种音：
//   success 操作成功 —— 清脆的"叮"，上行双音
//   error   操作失败/校验错误 —— 低沉的"嘟"，下行双音
//   scan    扫码识别到商品 —— 短促"嘀"单音
// AudioContext 浏览器策略要求首次用户手势后才能出声，这里懒初始化 + resume，
// 在任何环境下（含无手势、无 AudioContext 的测试环境）都不会抛错。
import { useAppStore } from '@/store/appStore'

export type SoundKind = 'success' | 'error' | 'scan'

/** 一个音节的参数：频率(Hz)、相对起点(秒)、时长(秒)、波形、音量 */
export interface Tone {
  freq: number
  start: number
  duration: number
  type: OscillatorType
  gain: number
}

/** 各提示音的音调参数（纯函数，可单测） */
export function soundTones(kind: SoundKind): Tone[] {
  switch (kind) {
    case 'scan':
      // 短促"嘀"：单音，高频正弦，80ms
      return [{ freq: 1046, start: 0, duration: 0.08, type: 'sine', gain: 0.18 }]
    case 'success':
      // 清脆"叮"：E5 → A5 上行双音
      return [
        { freq: 659, start: 0, duration: 0.12, type: 'sine', gain: 0.2 },
        { freq: 880, start: 0.11, duration: 0.16, type: 'sine', gain: 0.2 },
      ]
    case 'error':
      // 低沉"嘟"：E4 → C4 下行双音，三角波更闷
      return [
        { freq: 330, start: 0, duration: 0.16, type: 'triangle', gain: 0.25 },
        { freq: 262, start: 0.15, duration: 0.24, type: 'triangle', gain: 0.25 },
      ]
  }
}

let ctx: AudioContext | null = null

// 懒初始化 AudioContext；挂起时尝试 resume（无用户手势时 resume 会被拒，静默忽略）
function getContext(): AudioContext | null {
  try {
    if (typeof window === 'undefined') return null
    if (!ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ctx = new AC()
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return ctx
  } catch {
    return null
  }
}

/** 播放提示音。设置里关掉「操作提示音」后静默；任何异常都不影响业务操作 */
export function playSound(kind: SoundKind): void {
  try {
    if (!useAppStore.getState().soundEnabled) return
    const audio = getContext()
    if (!audio) return
    const t0 = audio.currentTime
    for (const tone of soundTones(kind)) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.type = tone.type
      osc.frequency.value = tone.freq
      const at = t0 + tone.start
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(tone.gain, at + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, at + tone.duration)
      osc.connect(gain)
      gain.connect(audio.destination)
      osc.start(at)
      osc.stop(at + tone.duration + 0.02)
    }
  } catch {
    // 音效只是反馈层，失败（如自动播放策略拦截）不影响操作本身
  }
}
