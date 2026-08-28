// 中文唤醒词检测（sherpa-onnx KeywordSpotter + kws-zipformer-wenetspeech 3.3M int8）
// 检测器全局单例，懒加载；渲染进程把 16kHz PCM 小块经 IPC 推过来，这里流式检测。
// 无 Electron 依赖（模型目录由 initKws 传入），可用纯 Node 单测。
// 错误风格沿用 voice.js：失败一律 { ok:false, reason }，大白话提示，调用方静默降级。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { checkKwsModel } from './kwsModelManager.js'

const require = createRequire(import.meta.url)

// 唤醒词「小杜小杜」：该 KWS 模型建模单元是拼音（声母+韵母，带声调），
// 自定义唤醒词要写成 token 序列 @中文名。所需 token（x/iǎo/d/ù）已逐一核对存在于模型 tokens.txt，
// 加载前还会再校验一遍，模型换版 token 缺失时给出大白话错误而不是静默失效。
const WAKE_WORD = '小杜小杜'
const WAKE_TOKENS = ['x', 'iǎo', 'd', 'ù', 'x', 'iǎo', 'd', 'ù']

let modelDir = null
let spotter = null
let stream = null
let loadError = null

/** 主进程启动时调用一次，指定模型目录 */
export function initKws(dir) {
  modelDir = dir
  spotter = null
  stream = null
  loadError = null
}

/** 模型与检测器状态，kws:status 通道用 */
export function kwsStatus() {
  const model = modelDir ? checkKwsModel(modelDir) : { ready: false, missing: [], sizeBytes: 0, dir: null }
  return {
    ready: model.ready,
    spotterLoaded: !!spotter,
    keyword: WAKE_WORD,
    dir: model.dir,
    sizeBytes: model.sizeBytes,
    loadError,
  }
}

/** 在模型目录生成 keywords.txt；唤醒词所需 token 必须在 tokens.txt 里全部存在 */
function writeKeywordsFile() {
  const tokensPath = path.join(modelDir, 'tokens.txt')
  const available = new Set(
    fs.readFileSync(tokensPath, 'utf8').split('\n').map((line) => line.trim().split(/\s+/)[0]),
  )
  const missing = WAKE_TOKENS.filter((t) => !available.has(t))
  if (missing.length > 0) {
    throw new Error(`模型词表缺少唤醒词所需的发音单元：${[...new Set(missing)].join('、')}`)
  }
  fs.writeFileSync(
    path.join(modelDir, 'keywords.txt'),
    `${WAKE_TOKENS.join(' ')} @${WAKE_WORD}\n`,
    'utf8',
  )
}

/** 加载检测器单例；已加载直接返回。模型缺失/加载失败返回 { ok:false, reason } */
export function preloadSpotter() {
  if (spotter) return { ok: true }
  if (!modelDir) return { ok: false, reason: '唤醒词功能还没初始化' }
  const model = checkKwsModel(modelDir)
  if (!model.ready) {
    return { ok: false, reason: '唤醒词模型还没下载，到设置页下载后就能用「小杜小杜」唤起' }
  }
  try {
    writeKeywordsFile()
    const sherpa = require('sherpa-onnx-node')
    const join = (f) => path.join(modelDir, f)
    spotter = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join('encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          decoder: join('decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          joiner: join('joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        },
        tokens: join('tokens.txt'),
        numThreads: 1, // 常驻后台监听，压低 CPU 占用
        provider: 'cpu',
        debug: 0,
      },
      keywordsFile: join('keywords.txt'),
    })
    stream = spotter.createStream()
    loadError = null
    return { ok: true }
  } catch (e) {
    loadError = e?.message ?? String(e)
    spotter = null
    stream = null
    return { ok: false, reason: `唤醒词引擎加载失败：${loadError}` }
  }
}

/** 与 voice.js 相同的 PCM 入参规整：Float32Array / 数组 / IPC 传来的 Buffer·Uint8Array */
function toFloat32(pcm) {
  if (pcm instanceof Float32Array) return pcm
  if (Array.isArray(pcm)) return Float32Array.from(pcm)
  if (pcm instanceof ArrayBuffer || ArrayBuffer.isView(pcm)) {
    const view = pcm instanceof ArrayBuffer ? new Uint8Array(pcm) : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    if (view.byteLength % 4 !== 0) return null
    return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
  }
  return null
}

/**
 * 推入一小块 16kHz 单声道 PCM，流式检测唤醒词
 * @param {{ pcm: Float32Array | ArrayBuffer | Uint8Array | number[], sampleRate?: number }} payload
 * @returns {{ok:true, detected:string|null} | {ok:false, reason:string}}
 */
export function pushPcm({ pcm, sampleRate = 16000 } = {}) {
  const loaded = preloadSpotter()
  if (!loaded.ok) return loaded

  const samples = toFloat32(pcm)
  if (!samples || samples.length === 0) return { ok: true, detected: null }
  // 防御：渲染端每次推 0.25s 左右，单次超过 5 秒视为异常直接拒绝
  if (samples.length > sampleRate * 5) return { ok: false, reason: '音频块太大了' }
  if (sampleRate !== 16000) return { ok: false, reason: '音频采样率不对，需要 16kHz' }

  try {
    stream.acceptWaveform({ sampleRate, samples })
    while (spotter.isReady(stream)) {
      spotter.decode(stream)
      const r = spotter.getResult(stream)
      if (r.keyword) {
        // 检出后重置流状态，避免同一句话反复触发
        spotter.reset(stream)
        return { ok: true, detected: r.keyword }
      }
    }
    return { ok: true, detected: null }
  } catch (e) {
    return { ok: false, reason: `唤醒词检测出错了：${e?.message ?? String(e)}` }
  }
}

/** 清空检测缓冲（用户开始/结束正式录音时调用，避免把正常说话误判成唤醒词） */
export function resetKws() {
  try {
    if (spotter && stream) spotter.reset(stream)
  } catch {
    // 重置失败不影响主流程
  }
}
