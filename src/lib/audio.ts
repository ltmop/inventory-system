// 录音小工具：MediaRecorder 产出的 Blob → base64，供 ai:transcribe 通道上传。
// 分块转码避免大音频 String.fromCharCode 一次展开爆栈；纯逻辑可单测。

/** Blob → base64（不含 data: 前缀） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * 录音 Blob（audio/webm 等）→ 16kHz 单声道 Float32 PCM（本地 sherpa-onnx 识别的输入格式）
 * 链路：decodeAudioData 解码 → OfflineAudioContext 重采样 → 取第 0 声道 Float32Array
 */
export async function blobToPcm16k(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer()
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(buf)
    const targetLen = Math.max(1, Math.ceil(decoded.duration * 16000))
    const off = new OfflineAudioContext(1, targetLen, 16000)
    const src = off.createBufferSource()
    src.buffer = decoded
    src.connect(off.destination)
    src.start()
    const rendered = await off.startRendering()
    return rendered.getChannelData(0)
  } finally {
    void ctx.close().catch(() => {})
  }
}
