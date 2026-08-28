// 本地离线语音合成（sherpa-onnx OfflineTts + vits-zh-aishell3 int8）
// 合成器全局单例，懒加载；只在主进程合成，渲染进程拿到 wav 字节自行播放。
// 无 Electron 依赖（模型目录由 initTts 传入），可用纯 Node 单测。
// 错误风格沿用 voice.js：失败一律 { ok:false, reason }，大白话提示，调用方静默降级回系统语音。
import path from 'node:path'
import { createRequire } from 'node:module'
import { checkTtsModel } from './ttsModelManager.js'

const require = createRequire(import.meta.url)

let modelDir = null
let tts = null
let loadError = null

/** 主进程启动时调用一次，指定模型目录（%APPDATA%/fishing-inventory/models/vits-zh-aishell3） */
export function initTts(dir) {
  modelDir = dir
  tts = null
  loadError = null
}

/** 模型与合成器状态，tts:status 通道用 */
export function ttsStatus() {
  const model = modelDir ? checkTtsModel(modelDir) : { ready: false, missing: [], sizeBytes: 0, dir: null }
  return {
    ready: model.ready,
    ttsLoaded: !!tts,
    dir: model.dir,
    sizeBytes: model.sizeBytes,
    loadError,
  }
}

/** 加载合成器单例；已加载直接返回。模型缺失/加载失败返回 { ok:false, reason } */
export function preloadTts() {
  if (tts) return { ok: true }
  if (!modelDir) return { ok: false, reason: '语音合成还没初始化' }
  const model = checkTtsModel(modelDir)
  if (!model.ready) {
    return { ok: false, reason: '语音合成模型还没下载，到设置页下载后就能离线播报' }
  }
  try {
    const sherpa = require('sherpa-onnx-node')
    const join = (f) => path.join(modelDir, f)
    tts = new sherpa.OfflineTts({
      model: {
        vits: {
          model: join('vits-aishell3.int8.onnx'),
          lexicon: join('lexicon.txt'),
          tokens: join('tokens.txt'),
        },
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      maxNumSentences: 1,
      // 数字/日期/电话号码按中文习惯读出来（"123"读"一百二十三"而不是"一二三"）。
      // 官方 aishell3 示例就是这三个规则；new_heteronym.fst 不属于 TTS 规则链，加进来引擎会直接崩。
      // 注意：fst 规则文件的加载走 C++ ifstream，Windows 下不支持中文路径——模型目录含非 ASCII
      // 字符时（如 Windows 用户名是中文）会直接让进程崩溃（spike 实测 exit 127），
      // 这种机器上宁可退化为逐位读数字，也绝不带 ruleFsts 启动。
      ...(/^[\x20-\x7e]+$/.test(modelDir)
        ? { ruleFsts: ['phone.fst', 'date.fst', 'number.fst'].map(join).join(',') }
        : {}),
    })
    loadError = null
    return { ok: true }
  } catch (e) {
    loadError = e?.message ?? String(e)
    tts = null
    return { ok: false, reason: `语音合成引擎加载失败：${loadError}` }
  }
}

/** float32 采样（[-1,1]）→ 标准 16bit PCM WAV 字节（44 字节头 + 数据），纯函数可单测 */
export function samplesToWav(samples, sampleRate) {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // fmt 块大小
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // 单声道
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // 字节率
  buf.writeUInt16LE(2, 32) // 块对齐
  buf.writeUInt16LE(16, 34) // 位深
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf
}

/**
 * 中文文本 → WAV 字节（16bit PCM 单声道，采样率随模型，aishell3 为 8000Hz）
 * 同步版：单测/脚本用；主进程 IPC 请用 synthesizeAsync（不阻塞事件循环）
 * @param {{ text: string, sid?: number, speed?: number }} payload
 * @returns {{ok:true, wav:Buffer, sampleRate:number, ms:number} | {ok:false, reason:string}}
 */
export function synthesize({ text, sid = 0, speed = 1.0 } = {}) {
  const checked = checkSynthesizeInput({ text, sid })
  if (!checked.ok) return checked
  try {
    const t0 = Date.now()
    // enableExternalBuffer:false —— Electron 的 V8 沙箱不允许 addon 直接持有外部缓冲，
    // 不显式关掉时同步 generate 报 "External buffers are not allowed"、generateAsync 直接挂死（实测）
    const audio = tts.generate({ text: checked.text, sid: checked.speakerId, speed, enableExternalBuffer: false })
    const ms = Date.now() - t0
    if (!audio?.samples?.length) return { ok: false, reason: '合成结果是空的' }
    return { ok: true, wav: samplesToWav(audio.samples, audio.sampleRate), sampleRate: audio.sampleRate, ms }
  } catch (e) {
    return { ok: false, reason: `语音合成出错了：${e?.message ?? String(e)}` }
  }
}

/** 输入校验 + 说话人 id 规整，两个合成入口共用 */
function checkSynthesizeInput({ text, sid }) {
  const loaded = preloadTts()
  if (!loaded.ok) return loaded
  const content = typeof text === 'string' ? text.trim() : ''
  if (!content) return { ok: false, reason: '没有要播报的内容' }
  // 防御：播报文本正常几十字，超过 500 字直接拒绝（合成耗时与字数成正比）
  if (content.length > 500) return { ok: false, reason: '播报内容太长了' }
  // 说话人 id 越界时回退 0 号（aishell3 共 174 个，启动时已从引擎读到实际数量）
  const speakerId = Number.isInteger(sid) && sid >= 0 && sid < tts.numSpeakers ? sid : 0
  return { ok: true, text: content, speakerId }
}

/**
 * 异步版合成：引擎在 worker 线程跑，主进程事件循环不被阻塞（长答复合成要好几秒）
 * @returns {Promise<{ok:true, wav:Buffer, sampleRate:number, ms:number} | {ok:false, reason:string}>}
 */
export async function synthesizeAsync({ text, sid = 0, speed = 1.0 } = {}) {
  const checked = checkSynthesizeInput({ text, sid })
  if (!checked.ok) return checked
  try {
    const t0 = Date.now()
    // enableExternalBuffer:false 的原因见 synthesize 注释
    const audio = await tts.generateAsync({ text: checked.text, sid: checked.speakerId, speed, enableExternalBuffer: false })
    const ms = Date.now() - t0
    if (!audio?.samples?.length) return { ok: false, reason: '合成结果是空的' }
    return { ok: true, wav: samplesToWav(audio.samples, audio.sampleRate), sampleRate: audio.sampleRate, ms }
  } catch (e) {
    return { ok: false, reason: `语音合成出错了：${e?.message ?? String(e)}` }
  }
}
