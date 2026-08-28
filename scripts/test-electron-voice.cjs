// Electron 实跑验证（语音链路只读版）：启动应用 → 经 preload 白名单验证
// tts:status / tts:speak（真实合成非空 wav）/ kws:status / kws:push（合成「小杜小杜」应检出）
// 需要 %APPDATA%/fishing-inventory/models 下 TTS 与 KWS 模型已就绪；不写任何业务数据。
const { _electron: electron } = require('playwright')

;(async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.waitForLoadState('load')
  await win.waitForTimeout(2500)

  const hasFi = await win.evaluate(() => typeof window.fi !== 'undefined')
  if (!hasFi) throw new Error('preload 未注入 window.fi')

  // TTS 状态：模型应已就绪（启动时 main.js 会预加载合成器）
  const ttsStatus = await win.evaluate(() => window.fi.invoke('tts:status'))
  console.log('tts:status →', JSON.stringify(ttsStatus))
  if (!ttsStatus.ready) throw new Error('TTS 模型未就绪')

  // 真实合成：返回非空 wav 字节（Uint8Array 经 IPC 回来是 {type:'Buffer'} 序列化形态）
  const speak = await win.evaluate(() => window.fi.invoke('tts:speak', { text: '老板，赤刃还剩五条。' }))
  const wavLen = speak?.wav?.length ?? speak?.wav?.data?.length ?? 0
  console.log('tts:speak → ok:', speak.ok, 'wav 字节数:', wavLen, '采样率:', speak.sampleRate, '耗时:', speak.ms, 'ms')
  if (!speak.ok || wavLen < 1000) throw new Error('tts:speak 合成失败或 wav 为空')

  // KWS 状态 + 用刚合成的「小杜小杜」音频喂 KWS，应检出唤醒词
  const kwsStatus = await win.evaluate(() => window.fi.invoke('kws:status'))
  console.log('kws:status →', JSON.stringify({ ...kwsStatus, dir: undefined }))
  if (!kwsStatus.ready) throw new Error('KWS 模型未就绪')

  const detected = await win.evaluate(async () => {
    const w = await window.fi.invoke('tts:speak', { text: '小杜小杜' })
    if (!w.ok) throw new Error('唤醒词合成失败：' + w.reason)
    const bytes = new Uint8Array(w.wav.data ?? w.wav)
    // 解析 wav（44 字节头 + int16）→ 重采样 16k → 0.25s 小块推送
    const dv = new DataView(bytes.buffer, bytes.byteOffset)
    const n = (bytes.length - 44) / 2
    const src = new Float32Array(n)
    for (let i = 0; i < n; i++) src[i] = dv.getInt16(44 + i * 2, true) / 32768
    const outLen = Math.round((n * 16000) / w.sampleRate)
    const pcm = new Float32Array(outLen + 9600)
    for (let i = 0; i < outLen; i++) {
      const pos = (i * (n - 1)) / (outLen - 1)
      const lo = Math.floor(pos)
      pcm[4800 + i] = src[lo] * (1 - pos + lo) + src[Math.min(lo + 1, n - 1)] * (pos - lo)
    }
    for (let off = 0; off < pcm.length; off += 4000) {
      const chunk = pcm.subarray(off, Math.min(off + 4000, pcm.length))
      const r = await window.fi.invoke('kws:push', { pcm: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) })
      if (!r.ok) throw new Error('kws:push 失败：' + r.reason)
      if (r.detected) return r.detected
    }
    return null
  })
  console.log('kws:push（小杜小杜）→ 检出:', detected)
  if (detected !== '小杜小杜') throw new Error('KWS 未检出唤醒词')

  await app.close()
  console.log('\nElectron 语音链路端到端验证全部通过')
  process.exit(0)
})().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
