// ai-orchestrator（M1，1.0 架构）：统一 AI 出口。
// 原则（顾问评审 9.3 + 复盘铁律）：
//   1. 本地算法兜底优先，AI 只做增强——断网/无 KEY 不哑
//   2. 兜底口径 = 主路径口径（AI 建议不得改变记账/搜索口径）
//   3. 前端只调本模块，不再散调 ai.js / doubao.js
import * as ai from './ai.js'
import * as doubao from './doubao.js'
import { logAudit } from './commands/helpers.js'
import { localFuzzyMatch } from './localSearch.js'

// ---------- AI 动作审计（M3-3：识别/建议写 audit_log，失败不阻断业务） ----------

function auditSearch(db, text, res) {
  if (db && res?.matched) {
    try {
      logAudit(db, 'AI纠错搜索', 'product', { text, corrected: res.corrected ?? '', source: res.source ?? '' }, 'AI')
    } catch { /* 审计失败不阻断搜索 */ }
  }
  return res
}

function auditPhoto(db, res) {
  if (db && res?.ok) {
    try {
      const content = typeof res.content === 'string' ? res.content : JSON.stringify(res.content ?? '') || ''
      logAudit(db, 'AI拍照识别', 'product', { source: res.source ?? '', content: content.slice(0, 200) }, 'AI')
    } catch { /* 审计失败不阻断识别 */ }
  }
  return res
}

// ---------- 统一出口 ----------

let dbRef = null
let dataDirRef = null

export function initOrchestrator(db, dataDir) {
  dbRef = db
  dataDirRef = dataDir
  ai.initAi(dataDir)
  ai.bindDb(db)
  doubao.initDoubao(dataDir)
}

/** 模糊搜索：本地兜底优先，AI 增强；断网/无 KEY 返回本地结果不哑 */
export async function smartSearch(rawText, { useAI = true } = {}) {
  const text = String(rawText ?? '').trim()
  if (!text) return { ok: false, reason: 'empty' }
  // 取商品清单（与 ai.correctSearchTerm 同源）
  const rows = dbRef
    ? dbRef.prepare("SELECT p.brand, p.model, p.sku_code FROM products p WHERE p.status != '停产' ORDER BY p.id LIMIT 300").all()
    : []
  const productNames = rows.map((r) => [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code || '').filter(Boolean)
  if (productNames.length === 0) return { ok: true, corrected: text, matched: false, source: 'none' }

  // ① 本地兜底（永远可用）
  const local = localFuzzyMatch(text, productNames)
  if (local && local.method !== 'fuzzy' && local.score === 0) {
    // 精确/子串命中直接返回（最快，不用 AI）
    return auditSearch(dbRef, text, { ok: true, corrected: local.name, matched: true, source: 'local:' + local.method })
  }

  // ② AI 增强（可选；无 KEY/断网自动回落本地）
  if (useAI) {
    try {
      const r = await ai.correctSearchTerm(text)
      if (r.ok && r.matched) return auditSearch(dbRef, text, { ok: true, corrected: r.corrected, matched: true, source: 'ai' })
    } catch { /* 回落本地 */ }
  }

  // ③ 本地模糊（含编辑距离）兜底
  if (local) return auditSearch(dbRef, text, { ok: true, corrected: local.name, matched: true, source: 'local:' + local.method })
  return { ok: true, corrected: text, matched: false, source: 'local:none' }
}

/** AI 助手问答（统一出口；无 KEY 返回明确提示不哑） */
export async function aiChat(messages) {
  try {
    const r = await ai.agentChat(messages)
    if (r.ok && r.message?.content) return { ok: true, content: r.message.content, source: 'ai' }
    return { ok: false, reason: r.reason || 'AI 不可用（未配 KEY 或断网），数据仍在本机可用' }
  } catch {
    return { ok: false, reason: 'AI 请求失败，本机功能不受影响' }
  }
}

/** 拍照识别（无 KEY 明确提示，不卡死） */
export async function analyzePhoto({ imageBase64, mimeType, prompt }) {
  // 优先豆包视觉（中文单据更准），失败回落 AI 网关视觉
  try {
    const r = await doubao.analyzeImageBase64({ imageBase64, mimeType, prompt })
    if (r.ok && r.content) return auditPhoto(dbRef, { ok: true, content: r.content, source: 'doubao' })
  } catch { /* 回落 */ }
  try {
    const r = await ai.parseInboundNote({ imageBase64, mimeType })
    if (r.ok) return auditPhoto(dbRef, { ok: true, content: JSON.stringify(r), source: 'ai' })
  } catch { /* 回落 */ }
  return { ok: false, reason: '拍照识别不可用（未配视觉 KEY）。请手动录入，不影响其他功能' }
}

/** 语音转文字（本地 sherpa 优先，云端兜底） */
export async function transcribe({ audioBase64, mimeType }) {
  try {
    const r = await ai.transcribeAudio({ audioBase64, mimeType })
    if (r.ok && r.text) return { ok: true, text: r.text, source: 'local' }
  } catch { /* 回落 */ }
  try {
    const r = await doubao.doubaoASR({ audioBase64, mimeType })
    if (r.ok && r.text) return { ok: true, text: r.text, source: 'doubao' }
  } catch { /* 回落 */ }
  return { ok: false, reason: '语音识别不可用' }
}

/** 编排层状态（前端显示 AI 可用性） */
export function orchestratorStatus() {
  return {
    localSearch: true, // 本地模糊搜索永远可用
    aiEnabled: ai.hasApiKey(),
    doubaoEnabled: doubao.doubaoStatus().configured,
    provider: ai.aiStatus()?.provider || null,
  }
}
