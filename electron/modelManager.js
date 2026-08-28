// 语音模型管理：检查 sherpa-onnx 模型文件是否就位，缺失时下载
// 与 voice.js 同级但职责分开：本模块只管"文件在不在、不对就下载"，不碰识别器/合成器。
// 无 Electron 依赖（目录由调用方传入），可用纯 Node 单测。
// 下载失败/超时一律 { ok:false, reason }，半成品文件当场清掉，绝不留半个模型给下次误判。
//
// createModelManager 工厂：ASR / TTS / KWS 三类模型共用同一套 校验→断点续下→清理 逻辑，
// 各自只声明 文件名+字节数+下载源。底部保留 ASR 模型的原有导出（checkModel/ensureModel/MODEL_NAME），
// 调用方与测试无需改动。
import fs from 'node:fs'
import path from 'node:path'

// 单文件下载的空转超时：30 秒一个没有新字节就放弃当前源（慢速网络传大文件总时长不设上限）
const STALL_TIMEOUT_MS = 30_000

/**
 * 创建一套模型管理器
 * @param {{ files: Array<{file:string, bytes:number}>, sources: Array<(file:string)=>string> }} spec
 *   files：期望文件与字节数（与验证过的模型逐字节一致，校验大小即可，不算 hash）
 *   sources：同一模型文件的多源镜像 URL 生成器，按顺序尝试
 */
export function createModelManager({ files, sources }) {
  /**
   * 检查模型文件是否齐备且大小正确
   * @returns {{ ready: boolean, dir: string, missing: string[], sizeBytes: number }}
   */
  function checkModel(modelDir) {
    const missing = []
    let sizeBytes = 0
    for (const { file, bytes } of files) {
      try {
        const st = fs.statSync(path.join(modelDir, file))
        if (st.size !== bytes) missing.push(file)
        else sizeBytes += st.size
      } catch {
        missing.push(file)
      }
    }
    return { ready: missing.length === 0, dir: modelDir, missing, sizeBytes }
  }

  /** 下载单个文件到 destDir（先写 .part，下完改名），依次尝试各镜像源 */
  async function downloadFile(file, expectedBytes, destDir, onProgress) {
    const dest = path.join(destDir, file)
    const part = dest + '.part'
    let lastError = null
    for (const url of sources.map((fn) => fn(file))) {
      const controller = new AbortController()
      let stallTimer = null
      const bump = () => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS)
      }
      try {
        bump()
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
        if (!res.ok || !res.body) {
          lastError = new Error(`HTTP ${res.status}`)
          continue
        }
        const total = Number(res.headers.get('content-length')) || expectedBytes
        const out = fs.createWriteStream(part)
        let received = 0
        const reader = res.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            bump() // 有数据流动就重置空转计时
            received += value.length
            if (!out.write(value)) await new Promise((r) => out.once('drain', r))
            onProgress?.({ file, received, total })
          }
        } finally {
          await new Promise((r) => out.end(r))
        }
        // 字节数对不上视为下载不完整，换源重来
        if (received !== expectedBytes) {
          lastError = new Error(`大小不符（收到 ${received}，应为 ${expectedBytes}）`)
          fs.rmSync(part, { force: true })
          continue
        }
        fs.renameSync(part, dest)
        return
      } catch (e) {
        lastError = e
        fs.rmSync(part, { force: true })
      } finally {
        if (stallTimer) clearTimeout(stallTimer)
      }
    }
    throw lastError ?? new Error('所有下载源都不可用')
  }

  /**
   * 确保模型就位：已就绪直接返回；缺失则下载（带进度回调），失败清理半成品
   * @param {string} modelDir 模型目录（%APPDATA%/fishing-inventory/models/<模型名>）
   * @param {(p:{file:string, received:number, total:number}) => void} [onProgress]
   * @returns {Promise<{ok:true, dir:string} | {ok:false, reason:string}>}
   */
  async function ensureModel(modelDir, onProgress) {
    const status = checkModel(modelDir)
    if (status.ready) return { ok: true, dir: modelDir }
    try {
      fs.mkdirSync(modelDir, { recursive: true })
      for (const { file, bytes } of files) {
        // 已存在且大小正确的文件跳过（支持断点续下：上次成了一半这次只补缺的）
        try {
          if (fs.statSync(path.join(modelDir, file)).size === bytes) continue
        } catch {
          // 不存在或读不到，走下载
        }
        await downloadFile(file, bytes, modelDir, onProgress)
      }
      const after = checkModel(modelDir)
      if (!after.ready) return { ok: false, reason: '模型文件下载不完整，请重试' }
      return { ok: true, dir: modelDir }
    } catch (e) {
      // 清掉可能残留的 .part 半成品，避免下次启动误判
      try {
        for (const f of fs.readdirSync(modelDir)) {
          if (f.endsWith('.part')) fs.rmSync(path.join(modelDir, f), { force: true })
        }
      } catch {
        // 清理失败不掩盖原始错误
      }
      const aborted = e?.name === 'AbortError'
      return {
        ok: false,
        reason: aborted
          ? '模型下载超时（网络太慢或断开了），请检查网络后重试'
          : `模型下载失败：${e?.message ?? String(e)}`,
      }
    }
  }

  return { checkModel, ensureModel }
}

// ---------- 离线语音识别模型（阿里 SenseVoiceSmall int8，约228MB） ----------
// 从 paraformer-zh-small（78MB，识别一般）升级到 SenseVoiceSmall：中文普通话/粤语/英语/日语/韩语，
// 自带标点与语气词过滤，识别商品品名准确率高一个档次。模型文件从 huggingface
// csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 校验，int8 版本 228MB。

export const MODEL_NAME = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'

// 期望文件与字节数（与 huggingface 模型仓库校验一致，校验大小即可，不算 hash）
export const MODEL_FILES = [
  { file: 'model.int8.onnx', bytes: 239233841 },
  { file: 'tokens.txt', bytes: 315894 },
]

// 同一模型文件的多源镜像，按顺序尝试。
// 注意：GitHub release 只发整包 tar.bz2（需要 bzip2 解码器，不值得为此引依赖），
// 所以备用源用 huggingface 主站（国内受限时 hf-mirror 已兜底，海外网络反之）。
const asr = createModelManager({
  files: MODEL_FILES,
  sources: [
    (file) => `https://hf-mirror.com/csukuangfj/${MODEL_NAME}/resolve/main/${file}`,
    (file) => `https://huggingface.co/csukuangfj/${MODEL_NAME}/resolve/main/${file}`,
  ],
})

export const checkModel = asr.checkModel
export const ensureModel = asr.ensureModel
