// 规格模板与命名规范化 —— 让"一个商品有多个规格"这件事从源头就整齐。
//
// 老板 2026-09-22 的核心反馈（原话）：
//   「一个品牌的产品，规格很多，但却要每一个都录入，而且还得拍照，规格命名格式不同一」
//   「就像一个文件夹一样，一个文件夹里有很多文件夹，这些文件夹里又有很多文件，而且名字是统一的」
//
// 实测他自己的库：223 个商品里 127 个没填品牌、只有 33 个填了规格名，
// 而且规格名是「360」「350g」「小」这种各写各的 —— 于是「同一个商品的不同规格」根本认不出来。
// 所以这里做两件事：① 给每个分类一套**统一写法**的常用规格（点一下就填）；
//                ② 用户自己打的字也**尽量归一**成统一写法（360 → 3.6米）。

/** 各分类的常用规格（写法统一，带单位） */
export const SPEC_TEMPLATES = {
  鱼竿: { unit: '个', label: '长度', values: ['2.7米', '3.6米', '3.9米', '4.5米', '5.4米', '6.3米', '7.2米'] },
  鱼线: { unit: '个', label: '线号', values: ['0.4号', '0.6号', '0.8号', '1.0号', '1.5号', '2.0号', '2.5号', '3.0号', '4.0号'] },
  鱼钩: { unit: '盒', label: '钩号', values: ['1号', '2号', '3号', '4号', '5号', '6号', '7号', '8号', '9号', '10号'] },
  饵料: { unit: '包', label: '规格', values: ['100g', '150g', '200g', '300g', '350g', '500g'] },
  浮漂: { unit: '支', label: '吃铅', values: ['1.0g', '1.5g', '2.0g', '2.5g', '3.0g'] },
  铅坠: { unit: '包', label: '重量', values: ['5g', '10g', '20g', '30g', '50g'] },
  路亚假饵: { unit: '个', label: '长度', values: ['5cm', '7cm', '10cm', '13cm'] },
  工具配件: { unit: '个', label: '规格', values: [] },
  其他: { unit: '个', label: '规格', values: [] },
}

/** 各分类规格的"规范单位写法"，归一的时候往这儿靠 */
const CANON_UNIT = {
  鱼竿: { re: /^(\d{3,4})\s*(?:cm)?$/, fmt: (m) => (Number(m[1]) / 100).toFixed(1).replace(/\.0$/, '') + '米' },
  鱼线: { re: /^(\d+(?:\.\d+)?)\s*[号#]?$/, fmt: (m) => String(m[1]) + '号' },
  鱼钩: { re: /^(\d+(?:\.\d+)?)\s*[号#]?$/, fmt: (m) => String(m[1]) + '号' },
  饵料: { re: /^(\d+(?:\.\d+)?)\s*(?:g|克)?$/i, fmt: (m) => String(m[1]) + 'g' },
  铅坠: { re: /^(\d+(?:\.\d+)?)\s*(?:g|克)?$/i, fmt: (m) => String(m[1]) + 'g' },
  浮漂: { re: /^(\d+(?:\.\d+)?)\s*(?:g|克)?$/i, fmt: (m) => String(m[1]) + 'g' },
  路亚假饵: { re: /^(\d+(?:\.\d+)?)\s*(?:cm|厘米)?$/i, fmt: (m) => String(m[1]) + 'cm' },
}

/**
 * 把一个手打的规格名归一到统一写法。
 * 老板说的「名字是统一的」就是这件事：360 → 3.6米、3 → 3号、350 → 350g。
 * 认不出来就原样返回（不硬改，免得把人家写对的东西改错）。
 */
export function normalizeSpecName(category, raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const rule = CANON_UNIT[String(category ?? '').trim()]
  if (!rule) return s
  const m = rule.re.exec(s.replace(/\s+/g, ''))
  if (!m) return s
  try { return rule.fmt(m) } catch (e) { return s }
}

/** 给前端的模板（按分类取，取不到给"其他"那套） */
export function specTemplatesFor(category) {
  const c = String(category ?? '').trim()
  return SPEC_TEMPLATES[c] || SPEC_TEMPLATES['其他']
}

export function allSpecTemplates() { return SPEC_TEMPLATES }
