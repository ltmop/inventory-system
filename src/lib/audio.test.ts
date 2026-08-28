// audio.ts 单测：Blob → base64 转换（node 环境 Blob/btoa 均可用）
import { describe, expect, it } from 'vitest'
import { blobToBase64 } from './audio'

describe('blobToBase64', () => {
  it('小音频正确转换（可解码回原字节）', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252])
    const b64 = await blobToBase64(new Blob([bytes]))
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(bytes))
  })

  it('超过一个分块（>32KB）也完整转换', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
    const b64 = await blobToBase64(new Blob([bytes]))
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(bytes))
  })

  it('空 Blob 转空串', async () => {
    expect(await blobToBase64(new Blob([]))).toBe('')
  })
})
