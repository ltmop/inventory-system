// sounds.ts 音调参数的纯逻辑单测（不触碰 AudioContext，node 环境可跑）
import { describe, expect, it } from 'vitest'
import { soundTones, playSound } from './sounds'

describe('soundTones', () => {
  it('scan 是短促单音，时长不超过 0.1s', () => {
    const tones = soundTones('scan')
    expect(tones).toHaveLength(1)
    expect(tones[0].duration).toBeLessThanOrEqual(0.1)
    expect(tones[0].start).toBe(0)
  })

  it('success 是上行双音（后音频率更高）', () => {
    const tones = soundTones('success')
    expect(tones).toHaveLength(2)
    expect(tones[1].freq).toBeGreaterThan(tones[0].freq)
    expect(tones[1].start).toBeGreaterThanOrEqual(tones[0].start)
  })

  it('error 是低沉下行双音（后音频率更低，整体低于 success）', () => {
    const tones = soundTones('error')
    expect(tones).toHaveLength(2)
    expect(tones[1].freq).toBeLessThan(tones[0].freq)
    const successMax = Math.max(...soundTones('success').map((t) => t.freq))
    const errorMax = Math.max(...tones.map((t) => t.freq))
    expect(errorMax).toBeLessThan(successMax)
  })

  it('所有音节的频率在可听范围、时长和音量为正', () => {
    for (const kind of ['scan', 'success', 'error'] as const) {
      for (const t of soundTones(kind)) {
        expect(t.freq).toBeGreaterThanOrEqual(100)
        expect(t.freq).toBeLessThanOrEqual(5000)
        expect(t.duration).toBeGreaterThan(0)
        expect(t.start).toBeGreaterThanOrEqual(0)
        expect(t.gain).toBeGreaterThan(0)
        expect(t.gain).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('playSound（无 AudioContext 环境）', () => {
  it('node 环境下静默返回不抛错', () => {
    expect(() => playSound('success')).not.toThrow()
    expect(() => playSound('error')).not.toThrow()
    expect(() => playSound('scan')).not.toThrow()
  })
})
