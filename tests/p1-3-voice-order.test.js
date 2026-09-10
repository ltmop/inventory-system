// P1-3 语音开单 · 纯逻辑管线测试（vitest）
// 覆盖任务书要求：数量词/金额/收款方式提取、本地命中不送 LLM、多候选送 LLM、
// LLM 越界标红、402 降级、确认前不落库、热词表构建
import { describe, it, expect } from 'vitest'
import {
  parseQuantityToken, extractQuantity, extractAmount, extractPayMethod, splitSegments,
  matchCandidates, localHit, buildLlmMessages, parseLlmReply, parseVoiceOrder, buildHotwords,
} from '../electron/voiceOrder.js'

const PRODUCTS = [
  { id: 1, brand: '光威', model: '赤刃4.5m 28调', sku_code: 'GW-CR45', category: '鱼竿', sub_category: null },
  { id: 2, brand: '光威', model: '赤刃3.6m', sku_code: 'GW-CR36', category: '鱼竿', sub_category: null },
  { id: 3, brand: '伊势尼', model: '6号钩', sku_code: 'YSN-6', category: '鱼钩', sub_category: null },
  { id: 4, brand: '老北京', model: '布鞋黑色42码', sku_code: 'LBJ-42', category: '鞋帽', sub_category: null },
  { id: 5, brand: '达瓦', model: '纺车轮2500', sku_code: 'DW-2500', category: '渔轮', sub_category: null },
]

describe('数量词提取', () => {
  it('中文/阿拉伯/复合数量都能解', () => {
    expect(parseQuantityToken('两')).toBe(2)
    expect(parseQuantityToken('三')).toBe(3)
    expect(parseQuantityToken('十二')).toBe(12)
    expect(parseQuantityToken('二十')).toBe(20)
    expect(parseQuantityToken('二十五')).toBe(25)
    expect(parseQuantityToken('3')).toBe(3)
    expect(parseQuantityToken('二三')).toBe(null) // 不确定不猜
  })
  it('从口语段提取数量并给出商品匹配剩余文本', () => {
    const r = extractQuantity('老北京布鞋42码拿两双')
    expect(r.qty).toBe(2)
    expect(r.rest).not.toContain('两双')
    expect(extractQuantity('光威赤刃').qty).toBe(1) // 没说数量默认 1
  })
})

describe('金额与收款方式提取', () => {
  it('收了80 / 一共125.5', () => {
    expect(extractAmount('伊势尼6号钩拿两个，收了80').amount).toBe(80)
    expect(extractAmount('一共125.5元').amount).toBe(125.5)
    expect(extractAmount('光威赤刃').amount).toBe(null)
  })
  it('现金/微信/支付宝/赊账口径', () => {
    expect(extractPayMethod('收了80现金').payMethod).toBe('现金')
    expect(extractPayMethod('微信付').payMethod).toBe('微信')
    expect(extractPayMethod('支付宝').payMethod).toBe('支付宝')
    const c = extractPayMethod('先赊账')
    expect(c.credit).toBe(true)
    expect(c.payMethod).toBe(null) // 赊账=实收0+选客户，不是收款方式（confirmCheckout 口径）
  })
})

describe('拆段', () => {
  it('标点与口语连接词都拆开', () => {
    expect(splitSegments('光威赤刃一根，伊势尼6号钩两包')).toHaveLength(2)
    expect(splitSegments('光威赤刃一根 再要 伊势尼两包')).toHaveLength(2)
  })
})

describe('本地匹配', () => {
  it('唯一高置信命中 → localHit 直接命中', () => {
    const cands = matchCandidates('伊势尼6号钩', PRODUCTS)
    const hit = localHit(cands)
    expect(hit?.id).toBe(3)
  })
  it('同品牌多型号 → 不直接命中（留给 LLM 或确认卡）', () => {
    const cands = matchCandidates('光威赤刃', PRODUCTS)
    expect(localHit(cands)).toBe(null) // 1 号 2 号都是光威赤刃
    expect(cands.length).toBeGreaterThanOrEqual(2)
  })
})

describe('LLM 段（防幻觉）', () => {
  it('本地唯一命中不送 LLM', async () => {
    let called = 0
    const r = await parseVoiceOrder('伊势尼6号钩拿两包', {
      products: PRODUCTS,
      callLlm: async () => { called++; return { ok: false } },
    })
    expect(r.ok).toBe(true)
    expect(called).toBe(0)
    expect(r.items[0]).toMatchObject({ productId: 3, qty: 2, matchedBy: 'local' })
    expect(r.degraded).toBe(false)
  })

  it('多候选片段送 LLM，返回候选集内 ID 才算命中', async () => {
    const r = await parseVoiceOrder('光威赤刃拿一根', {
      products: PRODUCTS,
      callLlm: async (msgs) => {
        // 验证 LLM 只收到候选清单而非全库（防幻觉输入边界）
        expect(msgs[1].content).toContain('1 = 光威 赤刃4.5m 28调')
        expect(msgs[1].content).toContain('2 = 光威 赤刃3.6m')
        expect(msgs[1].content).not.toContain('达瓦')
        return { ok: true, content: '{"items":[{"segment":1,"productId":1}]}', usage: { prompt_tokens: 10, completion_tokens: 5 }, remaining: 999 }
      },
    })
    expect(r.items[0]).toMatchObject({ productId: 1, matchedBy: 'llm' })
    expect(r.billing.remaining).toBe(999)
    expect(r.degraded).toBe(false)
  })

  it('LLM 返回候选集外 ID → 越界标 unmatched（确认卡标红）', async () => {
    const r = await parseVoiceOrder('光威赤刃拿一根', {
      products: PRODUCTS,
      callLlm: async () => ({ ok: true, content: '{"items":[{"segment":1,"productId":999}]}' }),
    })
    expect(r.items[0].matchedBy).toBe('unmatched')
    expect(r.items[0].productId).toBe(null)
  })

  it('LLM 输出包 markdown 代码块也能解析', async () => {
    const r = await parseVoiceOrder('光威赤刃拿一根', {
      products: PRODUCTS,
      callLlm: async () => ({ ok: true, content: '```json\n{"items":[{"segment":1,"productId":2}]}\n```' }),
    })
    expect(r.items[0].productId).toBe(2)
  })

  it('402 余额不足 → 降级：degraded=true，未命中项标 unmatched，原文保留', async () => {
    const r = await parseVoiceOrder('光威赤刃拿一根', {
      products: PRODUCTS,
      callLlm: async () => ({ ok: false, code: 402, reason: 'quota-exceeded' }),
    })
    expect(r.ok).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.failReason).toBe('quota-exceeded')
    expect(r.items[0].matchedBy).toBe('unmatched')
  })
})

describe('铁律与杂项', () => {
  it('确认前不落库：管线不接收 db，products 入参冻结后全程无写（任何篡改直接抛错）', async () => {
    const frozen = Object.freeze(PRODUCTS.map((p) => Object.freeze({ ...p })))
    const r = await parseVoiceOrder('伊势尼6号钩拿一包，收了10现金', { products: frozen })
    expect(r.ok).toBe(true)
    expect(r.totalAmount).toBe(10)
    expect(r.payMethod).toBe('现金')
    expect(r.items[0].qty).toBe(1)
  })

  it('buildHotwords 抽出品牌/品类词表（≥2 字，去重）', () => {
    const hw = buildHotwords(PRODUCTS)
    expect(hw).toContain('光威')
    expect(hw).toContain('伊势尼')
    expect(hw).toContain('鱼竿')
  })

  it('parseLlmReply 对垃圾输出安全返回空', () => {
    expect(parseLlmReply('这不是JSON', [{ candidates: [] }])).toEqual([])
  })
})
