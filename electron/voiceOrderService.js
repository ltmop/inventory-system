// ============================================================
// P1-3 语音开单 · electron 胶水层（编排：热词缓存 + 离线识别 + 计费 LLM 段）
// 与 voiceOrder.js（纯逻辑）分离：本文件碰 db / voice / aiQuota，voiceOrder.js 保持可单测。
// 降级铁律：402 / 断网 / 识别失败 → 返回 { degraded:true, text }，前端把识别文本填搜索框，
//          绝不白识别；确认卡不出现则不落库。
// 计时：返回 asrMs / parseMs / totalMs，供 ≤3 秒目标核验。
// ============================================================
import { transcribePcm } from './voice.js'
import * as voiceOrder from './voiceOrder.js'
import { chatForFeature } from './ai.js'
import { FEATURES } from './aiQuota.js'

let dbRef = null
let productsCache = []
let hotwords = ''

/** 主进程 db 就绪后调用一次；商品增删/导入后调 refreshVoiceOrderCache 即时刷新热词 */
export function initVoiceOrder(db) {
  dbRef = db
  refreshVoiceOrderCache()
}

/** 重建商品候选缓存 + 热词表（内存表，不落盘） */
export function refreshVoiceOrderCache() {
  if (!dbRef) return
  try {
    productsCache = dbRef
      .prepare("SELECT id, brand, model, sku_code, category, sub_category FROM products WHERE status != '停产'")
      .all()
    hotwords = voiceOrder.buildHotwords(productsCache)
  } catch { /* 刷新失败沿用旧缓存 */ }
}

function llmCall(messages) {
  return chatForFeature(messages, { maxTokens: 400, feature: FEATURES.VOICE_ORDER })
}

/** 文本 → 开单草稿（桌面端按钮 / 手机端共用） */
export async function parseOrderText(text) {
  if (!dbRef) return { ok: false, reason: 'db-not-ready' }
  const t0 = Date.now()
  const r = await voiceOrder.parseVoiceOrder(text, { products: productsCache, callLlm: llmCall })
  return { ...r, parseMs: Date.now() - t0 }
}

/** PCM 音频 → 离线识别（热词偏置）→ 开单草稿。音频不出本机/本店局域网。 */
export async function parseOrderAudio({ pcm, sampleRate } = {}) {
  if (!dbRef) return { ok: false, reason: 'db-not-ready' }
  const asr = transcribePcm({ pcm, sampleRate, hotwords })
  if (!asr.ok) return { ok: false, reason: asr.reason, stage: 'asr' }
  const t0 = Date.now()
  const r = await voiceOrder.parseVoiceOrder(asr.text, { products: productsCache, callLlm: llmCall })
  return { ...r, text: asr.text, asrMs: asr.ms, parseMs: Date.now() - t0, totalMs: asr.ms + (Date.now() - t0) }
}
