// 本地离线语音识别（sherpa-onnx + paraformer-zh-small int8）
// 识别器全局单例，懒加载；模型加载约 1.1s，之后单次转写 <150ms。
// 无 Electron 依赖（模型目录由 initVoice 传入），可用纯 Node 单测。
// 错误风格沿用 ai.js：失败一律 { ok:false, reason }，大白话提示，调用方静默降级。
import path from 'node:path'
import { createRequire } from 'node:module'
import { checkModel } from './modelManager.js'

const require = createRequire(import.meta.url)

let modelDir = null
let recognizer = null
let loadError = null

/**
 * 主进程启动时调用一次，指定模型目录
 * （%APPDATA%/fishing-inventory/models/sherpa-onnx-paraformer-zh-small-2024-03-09）
 */
export function initVoice(dir) {
  modelDir = dir
  recognizer = null
  loadError = null
}

/** 模型与识别器状态，voice:status 通道用 */
export function voiceStatus() {
  const model = modelDir ? checkModel(modelDir) : { ready: false, missing: [], sizeBytes: 0, dir: null }
  return {
    ready: model.ready,
    recognizerLoaded: !!recognizer,
    dir: model.dir,
    sizeBytes: model.sizeBytes,
    loadError,
  }
}

/** 加载识别器单例；已加载直接返回。模型缺失/加载失败返回 { ok:false, reason } */
export function preloadRecognizer() {
  if (recognizer) return { ok: true }
  if (!modelDir) return { ok: false, reason: '语音识别还没初始化' }
  const model = checkModel(modelDir)
  if (!model.ready) {
    return { ok: false, reason: '语音识别模型还没下载，点下方提示下载后就能离线识别' }
  }
  try {
    const sherpa = require('sherpa-onnx-node')
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        // 阿里 SenseVoiceSmall：中文识别更准，自带标点/语气词过滤
        senseVoice: {
          model: path.join(modelDir, 'model.int8.onnx'),
          language: 'zh',
          useInverseTextNormalization: true,
        },
        tokens: path.join(modelDir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    })
    loadError = null
    return { ok: true }
  } catch (e) {
    loadError = e?.message ?? String(e)
    return { ok: false, reason: `语音识别引擎加载失败：${loadError}` }
  }
}

/**
 * 16kHz 单声道 PCM → 文字
 * @param {{ pcm: Float32Array | ArrayBuffer | Uint8Array | number[], sampleRate?: number, hotwords?: string }} payload
 *   pcm 为 32 位浮点采样（渲染端 OfflineAudioContext 重采样产物）；IPC 传过来一般是 Buffer/Uint8Array
 *   hotwords 为空格分隔的词（如店里商品名），让识别器优先认出它们——老板说"伊势尼"带口音也偏向认成商品名
 * @returns {{ok:true, text:string, ms:number} | {ok:false, reason:string}}
 */
export function transcribePcm({ pcm, sampleRate = 16000, hotwords = '' } = {}) {
  const loaded = preloadRecognizer()
  if (!loaded.ok) return loaded

  let samples
  if (pcm instanceof Float32Array) {
    samples = pcm
  } else if (Array.isArray(pcm)) {
    samples = Float32Array.from(pcm)
  } else if (pcm instanceof ArrayBuffer || ArrayBuffer.isView(pcm)) {
    const view = pcm instanceof ArrayBuffer ? new Uint8Array(pcm) : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    // 字节数必须是 4 的倍数才是合法的 float32 PCM
    if (view.byteLength % 4 !== 0) return { ok: false, reason: '音频数据不完整，请再说一次' }
    samples = new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
  } else {
    return { ok: false, reason: '没有收到音频数据，请再说一次' }
  }
  if (samples.length === 0) return { ok: false, reason: '录音是空的，请再说一次' }
  // 防御：按住说话正常几秒，超过 60 秒的录音直接拒绝（16k × 60 = 96 万采样点）
  if (samples.length > sampleRate * 60) return { ok: false, reason: '录音太长了，请控制在 60 秒以内' }

  try {
    // 热词偏置：把店里商品名传进去，识别时优先往这些词上靠（对带口音的商品名识别有效）
    const hw = typeof hotwords === 'string' && hotwords.trim() ? hotwords.trim() : undefined
    const stream = hw ? recognizer.createStream(hw) : recognizer.createStream()
    const t0 = Date.now()
    stream.acceptWaveform({ sampleRate, samples })
    recognizer.decode(stream)
    const ms = Date.now() - t0
    const text = recognizer.getResult(stream).text?.trim()
    return text ? { ok: true, text, ms } : { ok: false, reason: 'empty' }
  } catch (e) {
    return { ok: false, reason: `识别出错了：${e?.message ?? String(e)}` }
  }
}
