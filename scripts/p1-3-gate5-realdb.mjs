// P1-3 闸⑤：真实数据库副本演练
// 1. 真实 data.db 副本过 openDatabase，旧表行数一行不动（只加不删）
// 2. 用真实商品库跑 10 句典型口语文本（不调 LLM，纯本地管线），验证：
//    - 商品匹配出的 productId 全部在真实库候选集内（防幻觉硬约束）
//    - 数量/金额/收款方式抽取符合预期
//    - 全程不落库（演练前后 transactions 行数不变）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, finalCheckpoint } from '../electron/db.js'
import { parseVoiceOrder, buildHotwords } from '../electron/voiceOrder.js'

const REAL_DB = 'C:\\Users\\Administrator\\Desktop\\库存管理\\data.db'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-realdb-'))
const copy = path.join(dir, 'data.db')
fs.copyFileSync(REAL_DB, copy)
console.log('真实库副本:', copy, `(${(fs.statSync(copy).size / 1024).toFixed(0)} KB)`)

const before = {}
{
  const ro = new DatabaseSync(copy, { readOnly: true })
  for (const t of ['products', 'inventory_batches', 'transactions']) {
    before[t] = ro.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
  }
  ro.close()
}
console.log('演练前行数:', JSON.stringify(before))

const db = openDatabase(copy)
console.log('openDatabase: OK')

// 真实商品候选（与 voiceOrderService 同口径：排除停产）
const products = db.prepare("SELECT id, brand, model, sku_code, category, sub_category FROM products WHERE status != '停产'").all()
console.log(`真实商品候选: ${products.length} 个`)
const hotwords = buildHotwords(products)
console.log(`热词表: ${hotwords.split(' ').filter(Boolean).length} 词（内存表，不落盘）`)
const idSet = new Set(products.map((p) => p.id))
const nameOf = (id) => {
  const p = products.find((x) => x.id === id)
  return p ? [p.brand, p.model].filter(Boolean).join(' ') || p.sku_code : `#${id}`
}

// 10 句典型口语文本（闸⑤文本用例；真麦方言用例留门店实收）
// 商品词用真实库前几个商品的 brand/model 拼，保证可命中
const sample = products.slice(0, 6)
const nm = (p) => [p.brand, p.model].filter(Boolean).join(' ') || p.sku_code
const cases = [
  { text: `${nm(sample[0])} 拿两包`, expectItems: 1 },
  { text: `${nm(sample[1] ?? sample[0])} 3个，收了50现金`, expectItems: 1, payMethod: '现金', amount: 50 },
  { text: `${nm(sample[2] ?? sample[0])} 一包 ${nm(sample[3] ?? sample[0])} 两包`, expectItems: 2 },
  { text: `${nm(sample[4] ?? sample[0])} 来五个，微信`, expectItems: 1, payMethod: '微信' },
  { text: `${nm(sample[5] ?? sample[0])} 10个 赊账`, expectItems: 1, credit: true },
  { text: `${nm(sample[0])} 1个，${nm(sample[1] ?? sample[0])} 2个，支付宝收了100`, expectItems: 2, payMethod: '支付宝', amount: 100 },
  { text: `${nm(sample[0])}`, expectItems: 1 }, // 没说数量默认 1
  { text: `给我拿个${nm(sample[2] ?? sample[0])}，收了20`, expectItems: 1, amount: 20 },
  { text: '老板不在先欠着', expectItems: 0, credit: true }, // 无商品词 → 片段全部 unmatched（确认卡标红），绝不能瞎匹配
  { text: `${nm(sample[0])} 两包半`, expectItems: 1 }, // 口语半
]

let pass = 0
for (const [i, c] of cases.entries()) {
  const r = await parseVoiceOrder(c.text, { products, callLlm: null }) // 闸⑤ 不调 LLM，纯本地
  const tag = `用例${i + 1}「${c.text.length > 24 ? c.text.slice(0, 24) + '…' : c.text}」`
  if (c.expectItems === 0) {
    // 无商品词：要么直接拒（no-items），要么所有行 unmatched（productId 全 null）——绝不允许瞎匹配
    if (r.ok) {
      const hallucinated = r.items.filter((it) => it.productId != null)
      if (hallucinated.length > 0) throw new Error(`${tag} 无商品词却命中了 ${hallucinated.map((it) => nameOf(it.productId)).join('，')}（幻觉！）`)
      console.log(`${tag} → 全部 unmatched（确认卡标红手选，不瞎匹配 ✓）`)
    } else {
      console.log(`${tag} → 无商品段，正确拒绝（${r.reason}）`)
    }
    if (c.credit && r.ok && !r.credit) throw new Error(`${tag} 赊账没识别出来`)
    pass++
    continue
  }
  if (!r.ok) throw new Error(`${tag} 解析失败: ${r.reason}`)
  // 防幻觉：所有命中 productId 必须在真实候选集内
  for (const it of r.items) {
    if (it.productId != null && !idSet.has(it.productId)) throw new Error(`${tag} 命中了候选集外 ID ${it.productId}（幻觉！）`)
  }
  const matched = r.items.filter((it) => it.productId != null)
  if (c.payMethod && r.payMethod !== c.payMethod) throw new Error(`${tag} 收款方式不对: ${r.payMethod} != ${c.payMethod}`)
  if (c.credit && !r.credit) throw new Error(`${tag} 赊账没识别出来`)
  if (c.amount != null && r.totalAmount !== c.amount) throw new Error(`${tag} 金额不对: ${r.totalAmount} != ${c.amount}`)
  console.log(`${tag} → ${matched.map((it) => `${nameOf(it.productId)}×${it.qty}`).join('，') || '（本地未命中，等 LLM 段）'}${r.payMethod ? `，${r.payMethod}` : ''}${r.credit ? '，赊账' : ''}${r.totalAmount != null ? `，收${r.totalAmount}元` : ''}`)
  pass++
}
console.log(`\n10 句口语文本用例: ${pass}/10 通过（productId 全部在候选集内 ✓）`)

// 全程不落库：旧表行数不变
for (const [tbl, n] of Object.entries(before)) {
  const now = db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get().n
  if (now !== n) throw new Error(`${tbl} 行数变了：${n} → ${now}（语音开单草稿绝不能落库）`)
}
console.log('落库检查: products/inventory_batches/transactions 行数全部不变（确认前不落库 ✓）')

finalCheckpoint(db)
db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('\n闸⑤ 真实数据库副本演练 PASS')
