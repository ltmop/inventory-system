// ============================================================
// P1-3 语音开单 · 纯逻辑管线（不依赖 electron / 网络 / KEY，可单测）
// 管线：拆段 → 数量词/金额/收款方式提取 → 本地模糊匹配 → 未命中片段才送 LLM
// 防幻觉硬约束（写死在代码里）：
// - LLM 返回的 productId 必须在本地候选集内，越界 → 该项 unmatched（确认卡标红手选）
// - 本地唯一高置信命中 → 绝不送 LLM（省 token）
// - LLM 只能收到"未命中片段 + 候选清单"，永远收不到全库（控 token）
// 铁律：本模块只产 draft，不落库；落库走 commands.confirmCheckout（确认卡确认后）
// ============================================================
import { levenshtein } from './localSearch.js'

// ---------- 中文数字 ----------
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
/** 解析中文/阿拉伯数量（1-99）：二十=20、十二=12、两=2、3=3；解不出返回 null */
export function parseQuantityToken(tok) {
  if (!tok) return null
  if (/^\d{1,2}$/.test(tok)) {
    const n = parseInt(tok, 10)
    return n > 0 ? n : null
  }
  if (tok === '十') return 10
  if (tok.length === 1) return CN_DIGIT[tok] ?? null
  if (tok.length === 2) {
    const [a, b] = tok
    if (a === '十' && CN_DIGIT[b] != null) return 10 + CN_DIGIT[b] // 十二
    if (CN_DIGIT[a] != null && b === '十') return CN_DIGIT[a] * 10 // 二十
    if (CN_DIGIT[a] != null && CN_DIGIT[b] != null) return null // "二三" 这种不确定，不猜
  }
  if (tok.length === 3 && tok[1] === '十' && CN_DIGIT[tok[0]] != null && CN_DIGIT[tok[2]] != null) {
    return CN_DIGIT[tok[0]] * 10 + CN_DIGIT[tok[2]] // 二十五
  }
  return null
}

// ---------- 数量提取：数量+量词（"两双"/"三个"/"2件"），没量词的"来5"也认 ----------
const MEASURE = '个件双条盒瓶包只副对卷米箱套把支根片袋'
const QTY_RE = new RegExp(`([0-9]{1,2}|[零一二两俩三四五六七八九]十[零一二两三四五六七八九]|[零一二两俩三四五六七八九]{1,2}|十)[${MEASURE}]`)
const QTY_LOOSE_RE = /(?:来|拿|要|卖|出)\s*([0-9]{1,2}|[零一二两俩三四五六七八九]{1,2}|十)(?![0-9点块钱])/u

/** 从一段文本提取数量，返回 { qty, rest }（rest 去掉数量短语，供商品匹配） */
export function extractQuantity(seg) {
  const m = seg.match(QTY_RE) || seg.match(QTY_LOOSE_RE)
  if (!m) return { qty: 1, rest: seg.trim() } // 没说数量默认 1（确认卡可改）
  const qty = parseQuantityToken(m[1])
  if (!qty) return { qty: 1, rest: seg.trim() }
  return { qty, rest: (seg.slice(0, m.index) + seg.slice(m.index + m[0].length)).trim() }
}

// ---------- 金额提取：整单实收（"收了80"/"收80块"/"一共80"） ----------
const AMOUNT_RE = /(?:收了?|一共|总共|合计)\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)\s*(?:块|元)?/u
export function extractAmount(text) {
  const m = text.match(AMOUNT_RE)
  if (!m) return { amount: null, rest: text }
  const amount = Number(m[1])
  return Number.isFinite(amount) && amount > 0
    ? { amount: Math.round(amount * 100) / 100, rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() }
    : { amount: null, rest: text }
}

// ---------- 收款方式：现金/微信/支付宝/其他（赊账=实收0+必须选客户，不是 payMethod） ----------
export function extractPayMethod(text) {
  if (/赊账|记账|欠着|先欠|挂账/u.test(text)) {
    return { payMethod: null, credit: true, rest: text.replace(/赊账|记账|欠着|先欠|挂账/gu, '').trim() }
  }
  if (/支付宝/u.test(text)) return { payMethod: '支付宝', credit: false, rest: text.replace(/支付宝/gu, '').trim() }
  if (/微信/u.test(text)) return { payMethod: '微信', credit: false, rest: text.replace(/微信/gu, '').trim() }
  if (/现金|现钱/u.test(text)) return { payMethod: '现金', credit: false, rest: text.replace(/现金|现钱/gu, '').trim() }
  return { payMethod: null, credit: false, rest: text }
}

// ---------- 拆段：标点 + 口语连接词 ----------
export function splitSegments(text) {
  return String(text || '')
    .split(/[,，。.;；、\n]|(?:再要|再来|还有|另外)/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

// ---------- 商品本地匹配：品牌段编辑距离 + 子串/前缀加分 ----------
/** 单个商品的可搜名：品牌 + 型号（+SKU 兜底） */
export const productNameOf = (p) => [p.brand, p.model].filter(Boolean).join(' ').trim() || p.sku_code || ''

function scoreOne(text, name) {
  const t = text.toLowerCase()
  const n = name.toLowerCase()
  if (!t || !n) return 0
  // 归一化去空格：商品名"品牌 型号"含空格，口语识别文本没有——先归一再比子串
  const t2 = t.replace(/\s+/g, '')
  const n2 = n.replace(/\s+/g, '')
  if (n2.includes(t2) || t2.includes(n2)) return Math.min(t2.length, n2.length) * 2 + 100 // 子串强命中
  const brand = n.split(/\s+/)[0] || n
  if (brand && (t.includes(brand) || brand.includes(t))) return Math.min(t.length, brand.length) * 2 + 60
  const d = levenshtein(t, brand)
  if (d <= 2) return 50 - d * 10 // 品牌段模糊（口音/识别误差容忍）
  return 0
}

/**
 * 候选打分：返回按分数降序的候选 [{ id, name, score }]
 * @param {Array} products 本地商品行（需含 id/brand/model/sku_code）
 */
export function matchCandidates(text, products, { limit = 5 } = {}) {
  const scored = []
  for (const p of products) {
    const name = productNameOf(p)
    const s = scoreOne(String(text || '').trim(), name)
    if (s > 0) scored.push({ id: p.id, name, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** 本地命中判定：第一名达高置信线且领先第二名足够 margin → 直接命中，不送 LLM */
const LOCAL_HIT_MIN = 100 // 子串级命中线
const LOCAL_HIT_MARGIN = 30
export function localHit(candidates) {
  if (candidates.length === 0) return null
  const [best, second] = candidates
  if (best.score >= LOCAL_HIT_MIN && best.score - (second?.score ?? 0) >= LOCAL_HIT_MARGIN) return best
  return null
}

// ---------- LLM 段：只收未命中片段 + 候选清单，输出严格 JSON ----------
export function buildLlmMessages(unresolved) {
  const segsText = unresolved
    .map((u, i) => {
      const cand = u.candidates.length
        ? u.candidates.map((c) => `  ${c.id} = ${c.name}`).join('\n')
        : '  （无候选）'
      return `片段${i + 1}："${u.text}"（数量 ${u.qty}）\n候选商品：\n${cand}`
    })
    .join('\n\n')
  return [
    {
      role: 'system',
      content:
        '你是门店语音开单解析器。顾客口语片段已经过本地匹配，这些是匹配不上的片段。' +
        '你的任务：对每个片段，从它的候选商品里选最可能的一个。' +
        '只输出 JSON，不要 markdown，不要解释：{"items":[{"segment":序号数字,"productId":候选ID或null}]}' +
        '铁律：productId 只能来自该片段的候选清单，禁止编造清单外的 ID；候选都靠不住就填 null。',
    },
    { role: 'user', content: segsText },
  ]
}

/** 解析 LLM 返回 + 防幻觉校验：productId 越界 → 该项 unmatched */
export function parseLlmReply(content, unresolved) {
  const cleaned = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed = null
  try { parsed = JSON.parse(cleaned) } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) { try { parsed = JSON.parse(m[0]) } catch { /* 解析失败 */ } }
  }
  if (!parsed || !Array.isArray(parsed.items)) return []
  const out = []
  for (const it of parsed.items) {
    const idx = Math.round(Number(it.segment)) - 1
    const seg = unresolved[idx]
    if (!seg) continue
    const pid = it.productId == null ? null : Math.round(Number(it.productId))
    // 防幻觉：必须在候选集内
    const hit = pid != null ? seg.candidates.find((c) => c.id === pid) : null
    out.push({ segmentIndex: idx, productId: hit ? pid : null, matchedBy: hit ? 'llm' : 'unmatched' })
  }
  return out
}

/**
 * 主管线：识别文本 → 开单草稿（不落库）
 * @param {string} text 离线识别文本
 * @param {{ products: Array, callLlm?: (messages)=>Promise<{ok:true,content:string,usage?:object,remaining?:number}|{ok:false,code?:number,reason?:string}> }} deps
 * @returns {Promise<{ ok:true, degraded:boolean, items:Array, totalAmount:number|null, payMethod:string|null, credit:boolean,
 *                     billing?:{usage:object,remaining:number}, failReason?:string }>}
 *   degraded=true：LLM 段不可用（402/断网/失败），只给本地结果 + 原文，调用方把文本填搜索框
 */
export async function parseVoiceOrder(text, { products, callLlm } = {}) {
  const raw = String(text || '').trim()
  if (!raw) return { ok: false, reason: 'empty' }

  // 整单级信息先抽走（金额/收款方式不在商品段里匹配）
  const a = extractAmount(raw)
  const p = extractPayMethod(a.rest)

  const items = []
  const unresolved = []
  for (const seg of splitSegments(p.rest)) {
    const { qty, rest } = extractQuantity(seg)
    if (!rest) continue
    const candidates = matchCandidates(rest, products)
    const hit = localHit(candidates)
    if (hit) {
      items.push({ productId: hit.id, name: hit.name, qty, matchedBy: 'local', candidates: [] })
    } else {
      unresolved.push({ text: rest, qty, candidates, itemIndex: items.length })
      items.push({ productId: null, name: rest, qty, matchedBy: 'pending', candidates })
    }
  }
  if (items.length === 0) return { ok: false, reason: 'no-items' }

  // 有未命中片段且 LLM 可用 → 收费解析段
  let billing = null
  let degraded = false
  let failReason = null
  if (unresolved.length > 0) {
    if (callLlm) {
      const r = await callLlm(buildLlmMessages(unresolved))
      if (r?.ok) {
        for (const fixed of parseLlmReply(r.content, unresolved)) {
          const u = unresolved[fixed.segmentIndex]
          const item = items[u.itemIndex]
          if (fixed.productId != null) {
            const c = u.candidates.find((x) => x.id === fixed.productId)
            items[u.itemIndex] = { ...item, productId: fixed.productId, name: c.name, matchedBy: 'llm' }
          } else {
            items[u.itemIndex] = { ...item, matchedBy: 'unmatched' }
          }
        }
        billing = r.usage ? { usage: r.usage, remaining: r.remaining } : null
      } else {
        degraded = true
        failReason = r?.code === 402 ? 'quota-exceeded' : (r?.reason || 'llm-failed')
        for (const u of unresolved) items[u.itemIndex] = { ...items[u.itemIndex], matchedBy: 'unmatched' }
      }
    } else {
      degraded = true // 无 LLM 通道（纯离线/测试）
      for (const u of unresolved) items[u.itemIndex] = { ...items[u.itemIndex], matchedBy: 'unmatched' }
    }
  }

  return {
    ok: true,
    degraded,
    failReason,
    items,
    totalAmount: a.amount,
    payMethod: p.payMethod,
    credit: p.credit,
    billing,
  }
}

// ---------- 热词表：品牌/品类词表（识别偏置用，内存缓存不落盘） ----------
export function buildHotwords(products) {
  const words = new Set()
  for (const p of products) {
    if (p.brand) words.add(String(p.brand))
    if (p.category) words.add(String(p.category))
    if (p.sub_category) words.add(String(p.sub_category))
  }
  return [...words].filter((w) => w.length >= 2).join('/')
}
