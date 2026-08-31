// ai-orchestrator（M1，1.0 架构）：统一 AI 出口。
// 原则（顾问评审 9.3 + 复盘铁律）：
//   1. 本地算法兜底优先，AI 只做增强——断网/无 KEY 不哑
//   2. 兜底口径 = 主路径口径（AI 建议不得改变记账/搜索口径）
//   3. 前端只调本模块，不再散调 ai.js / doubao.js
import * as ai from './ai.js'
import * as doubao from './doubao.js'

// ---------- 本地兜底算法（不依赖任何 KEY/网络） ----------

/** 编辑距离（Levenshtein），用于模糊搜索兜底 */
function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[m][n]
}

/**
 * 本地模糊匹配：子串/前缀/品牌段编辑距离（≤2），返回最佳候选。
 * 断网/无 KEY 时仍可用（顾问评审 9.3：本地兜底优先，AI 只增强）。
 * 对比品牌段（全名第一个词）而非全名——避免 model 后缀把编辑距离拖大。
 */
function localFuzzyMatch(text, productNames) {
  const t = String(text || '').trim().toLowerCase()
  if (!t) return null
  let best = null
  let bestScore = Infinity
  for (const name of productNames) {
    const n = String(name).toLowerCase()
    const brandSeg = n.split(' ')[0] // 品牌段（适配 brand model 结构）
    if (n === t) return { name, score: 0, method: 'exact' }
    if (n.includes(t)) {
      const s = n.length - t.length
      if (s < bestScore) { bestScore = s; best = { name, score: s, method: 'substr' } }
      continue
    }
    if (brandSeg.includes(t)) {
      const s = brandSeg.length - t.length
      if (s < bestScore) { bestScore = s; best = { name, score: s, method: 'brand' } }
      continue
    }
    if (t.includes(brandSeg) && brandSeg.length >= 2) {
      const s = t.length - brandSeg.length
      if (s < bestScore) { bestScore = s; best = { name, score: s, method: 'brand-contains' } }
      continue
    }
    const d = levenshtein(t, brandSeg)
    if (d <= 2 && d < bestScore) { bestScore = d; best = { name, score: d, method: 'brand-fuzzy' } }
  }
  return best
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
    return { ok: true, corrected: local.name, matched: true, source: 'local:' + local.method }
  }

  // ② AI 增强（可选；无 KEY/断网自动回落本地）
  if (useAI) {
    try {
      const r = await ai.correctSearchTerm(text)
      if (r.ok && r.matched) return { ok: true, corrected: r.corrected, matched: true, source: 'ai' }
    } catch { /* 回落本地 */ }
  }

  // ③ 本地模糊（含编辑距离）兜底
  if (local) return { ok: true, corrected: local.name, matched: true, source: 'local:' + local.method }
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
    if (r.ok && r.content) return { ok: true, content: r.content, source: 'doubao' }
  } catch { /* 回落 */ }
  try {
    const r = await ai.parseInboundNote({ imageBase64, mimeType })
    if (r.ok) return { ok: true, content: JSON.stringify(r), source: 'ai' }
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
