// AI 服务层：Kimi（月之暗面）OpenAI 兼容接口 + BYOK 密钥管理 + 工具调用 Agent
// 设计文档见 docs/AI-Agent设计文档.md
// 铁律：
// 1. 没 Key / 断网 / 超时 → 返回 { ok:false }，调用方静默降级，绝不影响主流程
// 2. 库存与经营数字必须来自本地 SQLite 工具查询，AI 不碰数据库连接以外的任何状态
// 3. 写操作只产草稿（draft_*），由前端确认卡确认后才走既有 commands 落库
import { safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { saveAiMessage, listAiMessages, saveInsight, listInsights, buildInsightsContext } from './db.js'

const API_URL = 'https://api.moonshot.cn/v1/chat/completions'
const MODEL = 'moonshot-v1-8k'
const VISION_MODEL = 'moonshot-v1-8k-vision-preview'
const TIMEOUT_MS = 30_000
const MAX_AGENT_ROUNDS = 5

let keyFile = null
let db = null

/** 主进程启动时调用一次，确定密钥文件位置 */
export function initAi(dataDir) {
  keyFile = path.join(dataDir, 'ai-key.enc')
}

/** 数据库就绪后绑定，供工具集查询（只读；写操作一律走草稿） */
export function bindDb(database) {
  db = database
}

export function hasApiKey() {
  try {
    return !!keyFile && fs.existsSync(keyFile) && fs.statSync(keyFile).size > 0
  } catch {
    return false
  }
}

export function aiStatus() {
  return { configured: hasApiKey(), model: MODEL, provider: 'Kimi（月之暗面）' }
}

/** 保存 Key：优先 safeStorage 系统级加密，不可用时退化为 base64（仅防君子） */
export function setApiKey(key) {
  const trimmed = String(key ?? '').trim()
  if (!trimmed) throw new Error('API Key 不能为空')
  if (!/^sk-[\w-]{10,}$/.test(trimmed)) throw new Error('Key 格式看起来不对（应以 sk- 开头）')
  let payload
  try {
    payload = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(trimmed).toString('base64')
      : `plain:${Buffer.from(trimmed, 'utf8').toString('base64')}`
  } catch {
    payload = `plain:${Buffer.from(trimmed, 'utf8').toString('base64')}`
  }
  fs.writeFileSync(keyFile, payload, 'utf8')
  return aiStatus()
}

export function clearApiKey() {
  try {
    if (hasApiKey()) fs.unlinkSync(keyFile)
  } catch {
    // 删除失败也按未配置返回
  }
  return aiStatus()
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

/** 原始请求：返回完整 message（含 tool_calls），失败统一吞成 { ok:false, reason } */
async function chatRaw(messages, { tools = undefined, maxTokens = 300, model = MODEL } = {}) {
  const key = readApiKey()
  if (!key) return { ok: false, reason: 'no-key' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const body = { model, messages, temperature: 0.3, max_tokens: maxTokens }
    if (tools) {
      body.tools = tools
      body.tool_choice = 'auto'
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
      return { ok: false, reason: `http-${res.status}`, detail: detail.slice(0, 200) }
    }
    const data = await res.json()
    const message = data.choices?.[0]?.message
    if (!message) return { ok: false, reason: 'empty' }
    return { ok: true, message }
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : 'network', detail: String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/** 简单问答（日报、连通性测试用），只取文本 */
async function chat(messages, opts = {}) {
  const r = await chatRaw(messages, opts)
  if (!r.ok) return r
  const content = r.message.content?.trim()
  return content ? { ok: true, content } : { ok: false, reason: 'empty' }
}

/** 设置页"保存并验证"用：发一个最小请求确认 Key 可用 */
export async function testConnection() {
  const r = await chat([{ role: 'user', content: '回复一个字：好' }], { maxTokens: 8 })
  return r.ok ? { ok: true } : r
}

const fmt = (fen) => `¥${(fen / 100).toFixed(2)}`
const yuan = (fen) => (fen == null ? null : Math.round(fen) / 100)
const fen = (y) => (y == null ? null : Math.round(Number(y) * 100))
// 交易时间戳是带 Z 的 UTC 串，门店在 UTC+8，"今天"必须按本地日期算
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)

/**
 * AI 一句话日报：输入前端汇总好的今日经营数据，输出一段人话小结
 * stats: { date, qty, revenue, profit, topItems: [{name, quantity}], lowStock: [{name, total}] }
 */
export async function dailySummary(stats) {
  const lines = [
    `日期：${stats.date}`,
    `今日营业额 ${fmt(stats.revenue)}，毛利 ${fmt(stats.profit)}，共售出 ${stats.qty} 件`,
  ]
  if (stats.topItems?.length) {
    lines.push(`卖得最好：${stats.topItems.map((t) => `${t.name}（${t.quantity}件）`).join('、')}`)
  }
  if (stats.lowStock?.length) {
    lines.push(`库存告急：${stats.lowStock.map((t) => `${t.name}（剩${t.total}件）`).join('、')}`)
  }
  return chat(
    [
      {
        role: 'system',
        content:
          '你是门店的账房先生。根据今日经营数据写一段打烊日报，80字以内，说人话，' +
          '禁止FIFO、批次、SKU等术语。先讲今天赚了多少，再点一句卖得好的货，最后提醒该补的货。' +
          '语气温和务实，不要emoji，不要标题，不要分点。',
      },
      { role: 'user', content: lines.join('\n') },
    ],
    { maxTokens: 220 },
  )
}

/**
 * 拍送货单：多模态识别单据 → 入库草稿行（不落库，前端确认后才执行）
 * @param {{ imageBase64: string, mimeType: string }} payload
 * @returns {Promise<{ok:true, items:Array} | {ok:false, reason:string}>}
 */
export async function parseInboundNote({ imageBase64, mimeType } = {}) {
  if (!db) return { ok: false, reason: 'db-not-ready' }
  if (!imageBase64 || typeof imageBase64 !== 'string') return { ok: false, reason: 'no-image' }
  // 防御：base64 体积过大直接拒绝（前端应已压缩到 1280px JPEG）
  if (imageBase64.length > 4_000_000) return { ok: false, reason: 'image-too-large' }
  const mime = /^image\/(jpeg|png|webp)$/.test(mimeType) ? mimeType : 'image/jpeg'

  // 店内商品清单喂给模型做匹配（ID|品牌|型号|品类|最近进价）
  const products = db
    .prepare('SELECT id, brand, model, category, sub_category, cost_price FROM products LIMIT 200')
    .all()
  const productList = products
    .map(
      (p) =>
        `${p.id}|${p.brand ?? ''}|${p.model ?? ''}|${p.category}${p.sub_category ? '/' + p.sub_category : ''}|进价${yuan(p.cost_price)}元`,
    )
    .join('\n')

  const r = await chatRaw(
    [
      {
        role: 'system',
        content:
          '你是门店的入库录单员。用户拍了一张送货单/进货单的照片，你要把单据上的商品逐行识别出来。' +
          '只输出 JSON，不要 markdown 代码块，不要任何解释文字。',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '识别这张送货单，输出格式：\n' +
              '{"items":[{"brand":"品牌","model":"型号","category":"品类","quantity":数量,"cost_price_yuan":单价数字,"product_id":匹配ID或null}]}\n' +
              '规则：\n' +
              '1. 能与店内商品清单匹配的行填 product_id（清单第一列），匹配不上填 null\n' +
              '2. category 用通用分类：食品饮料/日用百货/五金工具/电子电器/服饰鞋帽/文具办公/清洁日化/其他 之一\n' +
              '3. 金额只填数字（单位元），看不清的字段填 null，整行看不清就跳过\n' +
              '4. 只输出 JSON\n\n' +
              `店内商品清单（ID|品牌|型号|品类|最近进价）：\n${productList || '（店内暂无商品）'}`,
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
        ],
      },
    ],
    { model: VISION_MODEL, maxTokens: 1200 },
  )
  if (!r.ok) return r

  const text = r.message.content?.trim() ?? ''
  // 模型有时会包一层 ```json，剥掉再解析
  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    const m = jsonText.match(/\{[\s\S]*\}/)
    try {
      parsed = m ? JSON.parse(m[0]) : null
    } catch {
      parsed = null
    }
  }
  if (!parsed || !Array.isArray(parsed.items)) return { ok: false, reason: 'parse-failed', detail: text.slice(0, 200) }

  const items = parsed.items
    .filter((it) => it && Number(it.quantity) > 0)
    .slice(0, 50)
    .map((it) => ({
      product_id: Number.isInteger(it.product_id) && products.some((p) => p.id === it.product_id) ? it.product_id : null,
      brand: it.brand ?? null,
      model: it.model ?? null,
      category: typeof it.category === 'string' ? it.category : '其他',
      quantity: Math.round(Number(it.quantity)),
      cost_price_fen: it.cost_price_yuan != null && Number(it.cost_price_yuan) > 0 ? fen(it.cost_price_yuan) : null,
    }))
  if (items.length === 0) return { ok: false, reason: 'no-items', detail: '没识别出有效商品行，换张更清晰的照片试试' }
  return { ok: true, items }
}

// ---------- 工具集（Agent 的手）：6 只读 + 2 草稿 ----------

const nameOf = (r) => [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code

const toolImpls = {
  /** 按名称/品牌/条码/编号模糊找商品，附带当前总库存 */
  query_product({ keyword }) {
    const kw = `%${String(keyword ?? '').trim()}%`
    const rows = db
      .prepare(
        `SELECT p.id, p.sku_code, p.brand, p.model, p.category, p.sub_category, p.status,
                p.cost_price, p.suggest_price,
                COALESCE((SELECT SUM(quantity) FROM inventory_batches WHERE product_id = p.id), 0) AS stock
         FROM products p
         WHERE p.sku_code LIKE ? OR p.barcode LIKE ? OR p.brand LIKE ? OR p.model LIKE ?
         LIMIT 10`,
      )
      .all(kw, kw, kw, kw)
    if (rows.length === 0) return { found: 0, message: '没有找到匹配的商品，换个关键词试试' }
    return {
      found: rows.length,
      products: rows.map((r) => ({
        product_id: r.id,
        name: nameOf(r),
        编号: r.sku_code,
        品类: r.sub_category ? `${r.category}/${r.sub_category}` : r.category,
        当前库存: r.stock,
        状态: r.status,
        最近进价元: yuan(r.cost_price),
        建议售价元: yuan(r.suggest_price),
      })),
    }
  },

  /** 某商品的库存明细（分哪几次进的货） */
  stock_of({ product_id }) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id)
    if (!p) return { error: '商品不存在' }
    const batches = db
      .prepare(
        `SELECT batch_no, quantity, cost_price, location, inbound_date
         FROM inventory_batches WHERE product_id = ? AND quantity > 0
         ORDER BY inbound_date, id`,
      )
      .all(product_id)
    return {
      name: nameOf(p),
      总库存: batches.reduce((s, b) => s + b.quantity, 0),
      进货明细: batches.map((b) => ({
        批次号: b.batch_no,
        数量: b.quantity,
        进价元: yuan(b.cost_price),
        货位: b.location,
        入库日期: b.inbound_date,
      })),
    }
  },

  /** 某天经营汇总（默认今天） */
  daily_summary({ date } = {}) {
    const d = date || today()
    const outs = db
      .prepare(
        `SELECT t.quantity, t.unit_price, t.selling_price, p.brand, p.model, p.sku_code
         FROM transactions t JOIN products p ON p.id = t.product_id
         WHERE t.type = 'out' AND date(t.timestamp, 'localtime') = date(?)`,
      )
      .all(d)
    const qty = outs.reduce((s, r) => s + r.quantity, 0)
    const revenue = outs.reduce((s, r) => s + (r.selling_price ?? 0) * r.quantity, 0)
    const profit = outs.reduce((s, r) => s + ((r.selling_price ?? 0) - (r.unit_price ?? 0)) * r.quantity, 0)
    return {
      日期: d,
      售出件数: qty,
      营业额元: yuan(revenue),
      毛利元: yuan(profit),
      明细: outs.slice(0, 15).map((r) => ({
        商品: nameOf(r),
        数量: r.quantity,
        营业额元: yuan((r.selling_price ?? 0) * r.quantity),
      })),
    }
  },

  /** 近 N 天销量/毛利排行 */
  top_products({ days = 7 } = {}) {
    const d = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90)
    const rows = db
      .prepare(
        `SELECT p.brand, p.model, p.sku_code,
                SUM(t.quantity) AS qty,
                SUM(t.selling_price * t.quantity) AS revenue,
                SUM((t.selling_price - t.unit_price) * t.quantity) AS profit
         FROM transactions t JOIN products p ON p.id = t.product_id
         WHERE t.type = 'out' AND date(t.timestamp, 'localtime') >= date('now', 'localtime', ?)
         GROUP BY t.product_id ORDER BY qty DESC LIMIT 10`,
      )
      .all(`-${d} days`)
    if (rows.length === 0) return { message: `近 ${d} 天没有出库记录` }
    return {
      统计范围: `近${d}天`,
      排行: rows.map((r) => ({
        商品: nameOf(r),
        售出件数: r.qty,
        营业额元: yuan(r.revenue),
        毛利元: yuan(r.profit),
      })),
    }
  },

  /** 低库存清单 + 近30天销量 → 建议补货量 */
  low_stock_list({ threshold = 5 } = {}) {
    const t = Math.min(Math.max(parseInt(threshold, 10) || 5, 1), 100)
    const rows = db
      .prepare(
        `SELECT p.id, p.brand, p.model, p.sku_code,
                COALESCE(SUM(b.quantity), 0) AS stock,
                (SELECT COALESCE(SUM(t2.quantity), 0) FROM transactions t2
                  WHERE t2.product_id = p.id AND t2.type = 'out'
                    AND date(t2.timestamp, 'localtime') >= date('now', 'localtime', '-30 days')) AS sold30
         FROM products p LEFT JOIN inventory_batches b ON b.product_id = p.id
         WHERE p.status != '停产'
         GROUP BY p.id HAVING stock < ?
         ORDER BY stock ASC LIMIT 20`,
      )
      .all(t)
    if (rows.length === 0) return { message: `没有低于 ${t} 件的商品，库存健康` }
    return {
      阈值: t,
      清单: rows.map((r) => ({
        商品: nameOf(r),
        当前库存: r.stock,
        近30天卖出: r.sold30,
        建议补货: Math.max(0, r.sold30 - r.stock) || null,
      })),
    }
  },

  /** 滞销品：有库存但 N 天没卖出去 */
  slow_moving_list({ days = 90 } = {}) {
    const d = Math.min(Math.max(parseInt(days, 10) || 90, 7), 365)
    const rows = db
      .prepare(
        `SELECT p.id, p.brand, p.model, p.sku_code,
                COALESCE(SUM(b.quantity), 0) AS stock,
                (SELECT MAX(date(t2.timestamp, 'localtime')) FROM transactions t2
                  WHERE t2.product_id = p.id AND t2.type = 'out') AS last_out
         FROM products p LEFT JOIN inventory_batches b ON b.product_id = p.id
         GROUP BY p.id
         HAVING stock > 0 AND (last_out IS NULL OR last_out < date('now', 'localtime', ?))
         ORDER BY last_out ASC LIMIT 20`,
      )
      .all(`-${d} days`)
    if (rows.length === 0) return { message: `没有超过 ${d} 天未动销的商品` }
    return {
      标准: `${d}天未动销`,
      清单: rows.map((r) => ({
        商品: nameOf(r),
        库存: r.stock,
        最近卖出: r.last_out ?? '从没卖过',
      })),
    }
  },

  /** 入库草稿：不落库，返回给前端确认卡 */
  draft_inbound({ product_id, quantity, cost_price_yuan, location } = {}) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id)
    if (!p) return { error: '商品不存在，请先用 query_product 确认' }
    const qty = parseInt(quantity, 10)
    if (!Number.isFinite(qty) || qty <= 0) return { error: '数量必须是正整数' }
    const costFen = cost_price_yuan != null ? fen(cost_price_yuan) : p.cost_price
    return {
      draft: true,
      kind: 'inbound',
      product_id: p.id,
      product_name: nameOf(p),
      sku_code: p.sku_code,
      quantity: qty,
      cost_price_fen: costFen,
      cost_price_yuan: yuan(costFen),
      location: location ?? p.location ?? null,
      note: '这是入库草稿，请提醒用户核对后点确认按钮',
    }
  },

  /** 出库草稿：先查库存够不够，不落库 */
  draft_outbound({ product_id, quantity, selling_price_yuan } = {}) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id)
    if (!p) return { error: '商品不存在，请先用 query_product 确认' }
    const qty = parseInt(quantity, 10)
    if (!Number.isFinite(qty) || qty <= 0) return { error: '数量必须是正整数' }
    const stock = db
      .prepare('SELECT COALESCE(SUM(quantity),0) AS s FROM inventory_batches WHERE product_id = ?')
      .get(product_id).s
    if (qty > stock) return { error: `库存不足：${nameOf(p)} 现在只剩 ${stock} 件，出不了 ${qty} 件` }
    const sellFen = selling_price_yuan != null ? fen(selling_price_yuan) : p.suggest_price
    return {
      draft: true,
      kind: 'outbound',
      product_id: p.id,
      product_name: nameOf(p),
      sku_code: p.sku_code,
      quantity: qty,
      selling_price_fen: sellFen,
      selling_price_yuan: yuan(sellFen),
      current_stock: stock,
      note: '这是出库草稿，请提醒用户核对后点确认按钮',
    }
  },

  /** 知识沉淀：AI 发现值得记住的事时自主落库（唯一允许直接写的工具，只写 ai_insights 表） */
  save_insight({ kind, content } = {}) {
    const r = saveInsight(db, kind, content)
    return r.saved ? { saved: true, note: `已记住（${r.kind}），以后对话会带着这条记忆` } : { error: r.reason }
  },
}

// OpenAI function calling 的 JSON Schema 定义
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'query_product',
      description: '按名称、品牌、条码或商品编号模糊查找商品，返回商品ID和当前库存。要找某个商品时先调用它。',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '搜索关键词，如"赤刃"、"光威"' } },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stock_of',
      description: '查询指定商品的库存总数和分批次进货明细',
      parameters: {
        type: 'object',
        properties: { product_id: { type: 'integer', description: 'query_product 返回的 product_id' } },
        required: ['product_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'daily_summary',
      description: '查询某一天（默认今天）的营业额、毛利、售出件数和明细',
      parameters: {
        type: 'object',
        properties: { date: { type: 'string', description: 'YYYY-MM-DD，默认今天' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'top_products',
      description: '近N天（默认7天）销量/毛利排行，回答"什么卖得最好""什么最赚钱"',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '统计天数，1-90，默认7' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'low_stock_list',
      description: '低库存清单，附近30天销量和建议补货量，回答"哪些货该补了"',
      parameters: {
        type: 'object',
        properties: { threshold: { type: 'integer', description: '低于多少件算低库存，默认5' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slow_moving_list',
      description: '滞销品清单：有库存但N天（默认90）没卖出去的商品',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '多少天未动销算滞销，默认90' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_inbound',
      description: '生成入库草稿（不会真的入库）。用户说要入库/补货时调用，草稿由用户在界面上确认后才生效',
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'integer', description: 'query_product 返回的 product_id' },
          quantity: { type: 'integer', description: '入库数量' },
          cost_price_yuan: { type: 'number', description: '进价（元），不填用商品最近进价' },
          location: { type: 'string', description: '货位，不填用商品默认货位' },
        },
        required: ['product_id', 'quantity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_outbound',
      description: '生成出库草稿（不会真的出库）。用户说要出库/卖货时调用，会先检查库存够不够',
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'integer', description: 'query_product 返回的 product_id' },
          quantity: { type: 'integer', description: '出库数量' },
          selling_price_yuan: { type: 'number', description: '实际售价（元），不填用建议售价' },
        },
        required: ['product_id', 'quantity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_insight',
      description:
        '记住一条值得长期记住的事，下次对话还能想起来。' +
        'kind=fact：店里的事实（如"伊势尼6号钩7月周转12天"、回头客的常买清单）；' +
        'kind=preference：老板明确的经营习惯或偏好（如"周五下午统一补货"）；' +
        'kind=suggestion：你给老板的经营建议，存下来便于以后回顾验证建议是否靠谱',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['fact', 'preference', 'suggestion'], description: '记忆类型，默认 fact' },
          content: { type: 'string', description: '要记住的内容，一句话说清，含关键数字' },
        },
        required: ['content'],
      },
    },
  },
]

// 日期在每次调用时动态拼接，避免应用跨午夜运行后"今天"过期
// 记忆片段（ai_insights 中 active=1 的最近条目）注入系统提示，让 AI 带着记忆对话
const systemPrompt = () => {
  const memory = db ? buildInsightsContext(db, 20) : ''
  return `你是门店的库存助手。今天是 ${today()}。
规则：
1. 说人话，禁止术语：不说FIFO/批次/SKU，说"先来的货先卖/哪次进的货/商品编号"
2. 先给结论，再给关键数字；金额单位"元"，保留两位小数
3. 库存和经营数字必须来自工具查询，禁止凭记忆编造；用户问具体商品时先用 query_product 找到它
4. 入库/出库只能调用 draft_ 工具生成草稿（不是真的执行），结尾必须提醒"请核对后点确认按钮"
5. 回答控制在120字以内，简明扼要，不要emoji
6. 答不了的就说不知道，并建议用户去哪个页面操作（入库/出库/库存查询/盘点/供应商/导入/设置）
7. 对话中发现值得长期记住的事（回头客偏好、商品周转规律、老板明确的经营习惯），用 save_insight 工具记下来；给老板经营建议时用 kind='suggestion' 存，便于以后回顾验证${memory ? `\n${memory}` : ''}`
}

/** 单条用户消息超长截断，防 token 膨胀（保留前 4000 字） */
const MAX_MSG_CHARS = 4000
const clampContent = (s) => (s.length > MAX_MSG_CHARS ? s.slice(0, MAX_MSG_CHARS) + '……（内容过长已截断）' : s)

/**
 * Agent 主循环：带工具调用的多轮对话
 * 记忆沉淀：本轮 user 提问在入口处落库（ai_messages），成功的 assistant 答复在出口落库；
 * tool 中间步骤不存。落库失败静默跳过，绝不影响主流程。
 * @param {Array<{role:string, content:string}>} messages 前端对话历史（user/assistant）
 * @returns {Promise<{ok:true, content:string, drafts:object[], trace:string[]} | {ok:false, reason:string}>}
 */
export async function agentChat(messages) {
  if (!db) return { ok: false, reason: 'db-not-ready' }
  const convo = [
    { role: 'system', content: systemPrompt() },
    ...messages.slice(-12).map((m) => ({ role: m.role, content: clampContent(String(m.content ?? '')) })),
  ]
  // 只落本轮最新的一条 user 消息（历史已在之前的轮次落过）
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  try {
    if (lastUser) saveAiMessage(db, 'user', String(lastUser.content ?? ''))
  } catch {
    // 落库失败不影响对话
  }
  const drafts = []
  const trace = []

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    const r = await chatRaw(convo, { tools: TOOLS, maxTokens: 600 })
    if (!r.ok) return r
    const msg = r.message

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      convo.push(msg)
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name
        let result
        try {
          const args = JSON.parse(tc.function.arguments || '{}')
          trace.push(name)
          result = toolImpls[name] ? toolImpls[name](args) : { error: `未知工具 ${name}` }
          if (result?.draft) drafts.push(result)
        } catch (e) {
          result = { error: String(e?.message ?? e) }
        }
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          name,
          content: JSON.stringify(result),
        })
      }
      continue
    }

    const content = msg.content?.trim()
    const reply = content || (drafts.length > 0 ? '草稿已生成，请核对后点确认按钮。' : null)
    if (!reply) return { ok: false, reason: 'empty' }
    try {
      saveAiMessage(db, 'assistant', reply)
    } catch {
      // 落库失败不影响对话
    }
    return { ok: true, content: reply, drafts, trace }
  }
  return { ok: false, reason: 'too-many-rounds' }
}

// ---------- 语音识别 ASR（按住说话 → 文字） ----------
// Kimi 官方接口目前没有语音转文字端点，所以 ASR 走独立的 OpenAI 兼容
// /audio/transcriptions 服务，与聊天链路完全解耦：ASR 挂了不影响现有对话。
// 默认复用同一把 Kimi Key（若 Kimi 日后上线转录接口，改模型名即可直接通）。
// 切换到其他厂商只需改这两个常量（或打包前用环境变量覆盖），例如：
//   OpenAI：FI_ASR_BASE_URL=https://api.openai.com/v1  FI_ASR_MODEL=whisper-1
//   Groq：  FI_ASR_BASE_URL=https://api.groq.com/openai/v1  FI_ASR_MODEL=whisper-large-v3
// 注意：Key 由 setApiKey 统一管理（要求 sk- 开头），换厂商时 Key 也要换成对应平台的。
const ASR_BASE_URL = process.env.FI_ASR_BASE_URL ?? 'https://api.moonshot.cn/v1'
const ASR_MODEL = process.env.FI_ASR_MODEL ?? 'whisper-1'

const MIME_EXT = {
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/ogg': 'ogg',
}

/**
 * 语音转文字：base64 音频 → 文字。与 chatRaw 同一降级风格：
 * 没 Key / 超时 / 网络挂 / 接口报错一律 { ok:false, reason }，调用方静默降级。
 * @param {{ audioBase64: string, mimeType: string }} payload
 * @returns {Promise<{ok:true, text:string} | {ok:false, reason:string}>}
 */
export async function transcribeAudio({ audioBase64, mimeType } = {}) {
  const key = readApiKey()
  if (!key) return { ok: false, reason: 'no-key' }
  if (!audioBase64 || typeof audioBase64 !== 'string') return { ok: false, reason: 'no-audio' }
  // 防御：base64 超过 ~15MB 原始音频直接拒绝（按住说话正常只有几秒）
  if (audioBase64.length > 20_000_000) return { ok: false, reason: 'audio-too-large' }
  const buf = Buffer.from(audioBase64, 'base64')
  if (buf.length === 0) return { ok: false, reason: 'empty-audio' }
  const mime = MIME_EXT[mimeType] ? mimeType : 'audio/webm'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('file', new Blob([buf], { type: mime }), `voice.${MIME_EXT[mime]}`)
    form.append('model', ASR_MODEL)
    form.append('language', 'zh')
    const res = await fetch(`${ASR_BASE_URL}/audio/transcriptions`, {
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

/** ai:history 通道：最近 N 条对话（正序），前端启动恢复用 */
export function aiHistory(limit = 50) {
  if (!db) return []
  return listAiMessages(db, limit)
}

/** ai:insights 通道：知识列表查询（备用） */
export function aiInsights(limit = 50) {
  if (!db) return []
  return listInsights(db, { limit })
}
