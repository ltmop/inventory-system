// 行业模板（通用版）：超市/五金/文具/日杂四套一键套用。
// 套用 = 清空分类/单位并按模板重建（不动商品/库存/流水数据）。
// 模板定义内置于本文件（避免打包时少带 json 资源）。
import { inTransaction, logAudit } from './helpers.js'

export const INDUSTRY_TEMPLATES = [
  {
    id: 'supermarket',
    name: '超市 / 便利店',
    desc: '饮料零食粮油日化生鲜，称重商品按斤公斤',
    categories: ['饮料', '零食', '粮油', '日化', '生鲜', '乳品', '酒水', '调味品', '冷冻', '方便食品', '文具', '其他'],
    units: [
      { name: '件', allow_decimal: 0 }, { name: '瓶', allow_decimal: 0 }, { name: '袋', allow_decimal: 0 },
      { name: '包', allow_decimal: 0 }, { name: '盒', allow_decimal: 0 }, { name: '罐', allow_decimal: 0 },
      { name: '箱', allow_decimal: 0 }, { name: '斤', allow_decimal: 1 }, { name: '公斤', allow_decimal: 1 },
      { name: '克', allow_decimal: 1 }, { name: '升', allow_decimal: 1 }, { name: '毫升', allow_decimal: 1 },
      { name: '个', allow_decimal: 0 }, { name: '支', allow_decimal: 0 }, { name: '卷', allow_decimal: 1 }, { name: '提', allow_decimal: 0 },
    ],
  },
  {
    id: 'hardware',
    name: '五金 / 建材',
    desc: '螺丝工具电线管材油漆，按米/卷/公斤计量',
    categories: ['螺丝', '工具', '电线电缆', '管材', '油漆涂料', '五金件', '灯具', '开关插座', '锁具', '卫浴', '劳保', '其他'],
    units: [
      { name: '个', allow_decimal: 0 }, { name: '包', allow_decimal: 0 }, { name: '盒', allow_decimal: 0 },
      { name: '箱', allow_decimal: 0 }, { name: '件', allow_decimal: 0 }, { name: '套', allow_decimal: 0 },
      { name: '把', allow_decimal: 0 }, { name: '根', allow_decimal: 0 }, { name: '米', allow_decimal: 1 },
      { name: '卷', allow_decimal: 1 }, { name: '公斤', allow_decimal: 1 }, { name: '斤', allow_decimal: 1 },
      { name: '升', allow_decimal: 1 }, { name: '桶', allow_decimal: 0 }, { name: '罐', allow_decimal: 0 }, { name: '副', allow_decimal: 0 },
    ],
  },
  {
    id: 'stationery',
    name: '文具 / 办公',
    desc: '笔本纸办公用品美术，整盒整包计数',
    categories: ['笔', '本册', '纸品', '办公用品', '美术用品', '文件夹', '胶粘', '计算器', '打印耗材', '教具', '其他'],
    units: [
      { name: '支', allow_decimal: 0 }, { name: '本', allow_decimal: 0 }, { name: '册', allow_decimal: 0 },
      { name: '包', allow_decimal: 0 }, { name: '盒', allow_decimal: 0 }, { name: '箱', allow_decimal: 0 },
      { name: '个', allow_decimal: 0 }, { name: '卷', allow_decimal: 1 }, { name: '张', allow_decimal: 0 },
      { name: '沓', allow_decimal: 0 }, { name: '套', allow_decimal: 0 }, { name: '刀', allow_decimal: 0 },
      { name: '条', allow_decimal: 0 }, { name: '米', allow_decimal: 1 }, { name: '件', allow_decimal: 0 },
    ],
  },
  {
    id: 'daily',
    name: '日杂 / 百货',
    desc: '清洁厨具塑料纺织，家庭日用杂货',
    categories: ['清洁用品', '厨具', '塑料制品', '纺织', '洗护', '纸品', '收纳', '小家电', '餐具', '五金小件', '其他'],
    units: [
      { name: '个', allow_decimal: 0 }, { name: '件', allow_decimal: 0 }, { name: '套', allow_decimal: 0 },
      { name: '把', allow_decimal: 0 }, { name: '包', allow_decimal: 0 }, { name: '盒', allow_decimal: 0 },
      { name: '瓶', allow_decimal: 0 }, { name: '桶', allow_decimal: 0 }, { name: '箱', allow_decimal: 0 },
      { name: '条', allow_decimal: 0 }, { name: '块', allow_decimal: 0 }, { name: '张', allow_decimal: 0 },
      { name: '卷', allow_decimal: 1 }, { name: '米', allow_decimal: 1 }, { name: '斤', allow_decimal: 1 }, { name: '双', allow_decimal: 0 },
    ],
  },
]

/** 行业模板列表 */
export function listTemplates() {
  return INDUSTRY_TEMPLATES.map((t) => ({ id: t.id, name: t.name, desc: t.desc }))
}

/** 套用行业模板：清空分类/单位并按模板重建（不动商品/库存/流水） */
export function applyIndustryTemplate(db, { templateId, operator }) {
  const tpl = INDUSTRY_TEMPLATES.find((t) => t.id === templateId)
  if (!tpl) throw new Error('模板不存在：' + templateId)
  return inTransaction(db, () => {
    db.prepare('DELETE FROM categories').run()
    tpl.categories.forEach((c, i) => {
      db.prepare('INSERT INTO categories (name, sort_order, template_type) VALUES (?, ?, ?)').run(c, i, tpl.id)
    })
    db.prepare('DELETE FROM units').run()
    tpl.units.forEach((u, i) => {
      db.prepare('INSERT INTO units (name, allow_decimal, sort_order) VALUES (?, ?, ?)').run(u.name, u.allow_decimal ? 1 : 0, i)
    })
    db.prepare("INSERT INTO settings (key, value) VALUES ('industry_template', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(tpl.id)
    logAudit(db, '套用行业模板', tpl.name, { templateId: tpl.id, categories: tpl.categories.length, units: tpl.units.length }, operator)
    return { ok: true, name: tpl.name, categories: tpl.categories.length, units: tpl.units.length }
  })
}
