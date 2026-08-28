// 豆包视觉模型 2.1：火山方舟 OpenAI 兼容接口
// 用途：分析店面照片 → 识别货架/品类/区位布局
// 与 ai.js（Kimi）平行，独立 Key 管理，互不干扰
// 参考：D:/AI知识库/30-AI技术积累/豆包视觉模型接入.md

import { safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
const MODEL = 'doubao-seed-2-1-turbo-260628'
// 视觉识别用 pro 版：进货单/商品图识别品牌、规格更准（turbo 快但细节差）
const VISION_MODEL = 'doubao-seed-2-1-pro-260628'
const TIMEOUT_MS = 45_000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5MB

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

let keyFile = null

export function initDoubao(dataDir) {
  keyFile = path.join(dataDir, 'doubao-key.enc')
}

function hasApiKey() {
  try {
    return !!keyFile && fs.existsSync(keyFile) && fs.statSync(keyFile).size > 0
  } catch {
    return false
  }
}

export function doubaoStatus() {
  return { configured: hasApiKey(), model: MODEL, provider: '豆包视觉模型（火山方舟）' }
}

export function setDoubaoKey(key) {
  const trimmed = String(key ?? '').trim()
  if (!trimmed) throw new Error('API Key 不能为空')
  let payload
  try {
    payload = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(trimmed).toString('base64')
      : `plain:${Buffer.from(trimmed, 'utf8').toString('base64')}`
  } catch {
    payload = `plain:${Buffer.from(trimmed, 'utf8').toString('base64')}`
  }
  fs.writeFileSync(keyFile, payload, 'utf8')
  return doubaoStatus()
}

export function clearDoubaoKey() {
  try {
    if (hasApiKey()) fs.unlinkSync(keyFile)
  } catch { /* ignore */ }
  return doubaoStatus()
}

function readApiKey() {
  if (!hasApiKey()) return null
  try {
    const raw = fs.readFileSync(keyFile, 'utf8')
    if (raw.startsWith('plain:')) return Buffer.from(raw.slice(6), 'base64').toString('utf8')
    return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  } catch {
    return null
  }
}

/**
 * 豆包视觉分析：传入本地图片路径 + 分析指令，返回文字结果
 * @param {{ imagePath: string, prompt: string }} params
 * @returns {Promise<{ok:true, content:string} | {ok:false, reason:string, detail?:string}>}
 */
export async function analyzeImage({ imagePath, prompt } = {}) {
  const key = readApiKey()
  if (!key) return { ok: false, reason: 'no-key', detail: '请先在设置页配置豆包视觉模型的 API Key' }

  if (!imagePath || typeof imagePath !== 'string') return { ok: false, reason: 'no-image' }
  if (!fs.existsSync(imagePath)) return { ok: false, reason: 'file-not-found', detail: `图片不存在：${imagePath}` }

  const stat = fs.statSync(imagePath)
  if (stat.size === 0) return { ok: false, reason: 'empty-file' }
  if (stat.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'image-too-large', detail: `图片 ${(stat.size / 1024 / 1024).toFixed(1)}MB，超过 5MB 限制` }
  }

  const ext = path.extname(imagePath).toLowerCase()
  const mimeType = MIME_MAP[ext] ?? 'image/jpeg'

  const imgBuf = fs.readFileSync(imagePath)
  const imgB64 = imgBuf.toString('base64')
  if (imgB64.length > 20_000_000) {
    return { ok: false, reason: 'image-too-large', detail: 'base64 编码后超过 API 限制，请压缩图片' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const body = {
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imgB64}` } },
          { type: 'text', text: String(prompt ?? '描述这张图片的内容') },
        ],
      }],
      max_tokens: 1500,
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, reason: `http-${res.status}`, detail: detail.slice(0, 300) }
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) return { ok: false, reason: 'empty-response' }
    return { ok: true, content }
  } catch (e) {
    return {
      ok: false,
      reason: e?.name === 'AbortError' ? 'timeout' : 'network',
      detail: String(e),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 豆包视觉分析（base64 直接传入）：手机端/进货单等场景图片已经是 base64，不再走文件路径。
 * @param {{ imageBase64: string, mimeType?: string, prompt?: string }} params
 * @returns {Promise<{ok:true, content:string} | {ok:false, reason:string, detail?:string}>}
 */
export async function analyzeImageBase64({ imageBase64, mimeType = 'image/jpeg', prompt = '描述这张图片的内容' } = {}) {
  const key = readApiKey()
  if (!key) return { ok: false, reason: 'no-key', detail: '请先在设置页配置豆包视觉模型的 API Key' }
  if (!imageBase64 || typeof imageBase64 !== 'string') return { ok: false, reason: 'no-image' }
  if (imageBase64.length > 20_000_000) {
    return { ok: false, reason: 'image-too-large', detail: '图片 base64 编码后过大，请压缩' }
  }
  const mime = /^image\/(jpeg|png|webp|gif|bmp)$/.test(mimeType) ? mimeType : 'image/jpeg'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const body = {
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
          { type: 'text', text: String(prompt ?? '') },
        ],
      }],
      max_tokens: 2500, // 进货单行数多时要够输出，防止截断
    }
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, reason: `http-${res.status}`, detail: detail.slice(0, 300) }
    }
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content?.trim()
    return content ? { ok: true, content } : { ok: false, reason: 'empty-response' }
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : 'network', detail: String(e) }
  } finally {
    clearTimeout(timer)
  }
}

// 语音识别（火山方舟 OpenAI 兼容转录端点）：本地小模型识别差时的云端增强，失败静默降级
const ASR_URL = 'https://ark.cn-beijing.volces.com/api/v3/audio/transcriptions'
const ASR_MODEL = 'doubao-asr-default'
const ASR_MIME_EXT = { 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }

/**
 * 豆包语音转文字：base64 音频 → 文字（火山方舟 doubao-asr-default）
 * @param {{ audioBase64: string, mimeType?: string }} params
 * @returns {Promise<{ok:true, text:string} | {ok:false, reason:string}>}
 */
export async function doubaoASR({ audioBase64, mimeType = 'audio/webm' } = {}) {
  const key = readApiKey()
  if (!key) return { ok: false, reason: 'no-key' }
  if (!audioBase64 || typeof audioBase64 !== 'string') return { ok: false, reason: 'no-audio' }
  if (audioBase64.length > 20_000_000) return { ok: false, reason: 'audio-too-large' }
  const buf = Buffer.from(audioBase64, 'base64')
  if (buf.length === 0) return { ok: false, reason: 'empty-audio' }
  const mime = ASR_MIME_EXT[mimeType] ? mimeType : 'audio/webm'
  const ext = ASR_MIME_EXT[mime]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('file', new Blob([buf], { type: mime }), `voice.${ext}`)
    form.append('model', ASR_MODEL)
    const res = await fetch(ASR_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, reason: `http-${res.status}`, detail: detail.slice(0, 200) }
    }
    const data = await res.json()
    const text = data.text?.trim()
    return text ? { ok: true, text } : { ok: false, reason: 'empty' }
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : 'network', detail: String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 豆包纯文本对话（店铺布局问答等不需要图片的场景）
 * @param {string} userMessage
 * @returns {Promise<{ok:true, content:string} | {ok:false, reason:string}>}
 */
export async function doubaoChat(userMessage) {
  const key = readApiKey()
  if (!key) return { ok: false, reason: 'no-key' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: String(userMessage) }],
        max_tokens: 800,
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return { ok: false, reason: `http-${res.status}`, detail: detail.slice(0, 200) }
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content?.trim()
    return content ? { ok: true, content } : { ok: false, reason: 'empty-response' }
  } catch (e) {
    return {
      ok: false,
      reason: e?.name === 'AbortError' ? 'timeout' : 'network',
      detail: String(e),
    }
  } finally {
    clearTimeout(timer)
  }
}
