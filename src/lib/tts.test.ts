// tts.ts 纯逻辑单测（不触碰 speechSynthesis，node 环境可跑）
import { describe, expect, it } from 'vitest'
import { pickChineseVoice, readTtsEnabled, writeTtsEnabled, speak, stopSpeaking } from './tts'

describe('pickChineseVoice', () => {
  it('优先选 zh-CN', () => {
    const voices = [
      { lang: 'zh-TW', name: 'tw' },
      { lang: 'zh-CN', name: 'cn' },
      { lang: 'en-US', name: 'en' },
    ]
    expect(pickChineseVoice(voices)?.name).toBe('cn')
  })

  it('没有 zh-CN 时退回任意中文语音', () => {
    const voices = [
      { lang: 'en-US', name: 'en' },
      { lang: 'zh-HK', name: 'hk' },
    ]
    expect(pickChineseVoice(voices)?.name).toBe('hk')
  })

  it('兼容下划线写法 zh_CN', () => {
    const voices = [{ lang: 'zh_CN', name: 'cn' }]
    expect(pickChineseVoice(voices)?.name).toBe('cn')
  })

  it('完全没有中文语音返回 null', () => {
    expect(pickChineseVoice([{ lang: 'en-US' }])).toBeNull()
    expect(pickChineseVoice([])).toBeNull()
  })
})

describe('开关持久化（node 无 window 环境）', () => {
  it('读取默认开，写入静默不抛错', () => {
    expect(readTtsEnabled()).toBe(true)
    expect(() => writeTtsEnabled(false)).not.toThrow()
    expect(readTtsEnabled()).toBe(true)
  })
})

describe('speak / stopSpeaking（node 无 speechSynthesis 环境）', () => {
  it('静默返回不抛错', () => {
    expect(() => speak('赤刃还剩五条')).not.toThrow()
    expect(() => speak('')).not.toThrow()
    expect(() => stopSpeaking()).not.toThrow()
  })
})
