// 机器校验：分类选项必须来自**活的**数据源，不能再出现"恒为空的常量"
//
// 背景（真实缺陷，2026-09-13 查出）：
//   src/types/index.ts 曾导出 `CATEGORIES: Category[] = []`，注释写着"运行时由 loadAll 填充"，
//   但**从 v0.3.2 首次入库起就没有任何代码填充过它**。它被 5 处当成分类选项来源，后果：
//     · 库存查询的「品类」筛选只有「全部品类」，**没法按分类筛**（owner 原话「库存查询需要有商品的大分类」）
//     · 编辑商品的品类下拉是空的
//     · 新建盘点的品类下拉是空的
//     · 批量导入的提示「品类须为以下之一：」后面一片空白
//     · 导入建档时 `CATEGORIES.includes(...)` 恒为 false → **每个导入商品的品类都被写成「其他」**
//   正确来源是 store 的 categories 字段（loadAll 从 categories 表拉取）。
//
// 这个脚本把"不许再出现空常量当选项源"变成可复算的检查。
//
// 跑法：node scripts/verify-category-wiring.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', 'src')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(e.name)) files.push({ rel: path.relative(SRC, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') })
  }
}
walk(SRC)
console.log('扫描 ' + files.length + ' 个 src 下的 .ts/.tsx 文件\n')

// 去掉注释行后再判断，避免"注释里提到它"被误判（第一版判据就栽在这）
const stripComments = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

console.log('=== ① 死常量已删除 ===')
const types = files.find((f) => f.rel === 'types/index.ts')
ok('types/index.ts 里不再导出 CATEGORIES', !!types && !/export const CATEGORIES/.test(stripComments(types.text)))

console.log('\n=== ② 没有任何文件 import CATEGORIES ===')
const importers = files.filter((f) => /import\s*\{[^}]*\bCATEGORIES\b[^}]*\}\s*from/.test(stripComments(f.text))).map((f) => f.rel)
ok('零 import', importers.length === 0, importers.join(', '))

console.log('\n=== ③ 没有任何文件使用 CATEGORIES 作为选项源 ===')
const users = files.filter((f) => /(?<![A-Z_])CATEGORIES\s*(\.|as\b|\))/.test(stripComments(f.text))).map((f) => f.rel)
ok('零使用（EXPENSE_CATEGORIES 不算）', users.length === 0, users.join(', '))

console.log('\n=== ④ 五个曾经的受害点都改用了 store 的 categories ===')
const SITES = [
  ['pages/inventory/InventoryFilterBar.tsx', '库存查询的品类筛选'],
  ['pages/inventory/EditProductDialog.tsx', '编辑商品的品类下拉'],
  ['pages/stocktake/CreateStockTakeDialog.tsx', '新建盘点的品类下拉'],
  ['pages/ImportPage.tsx', '批量导入的提示文案'],
  ['pages/InboundPage.tsx', '导入建档时的品类校验'],
]
for (const [rel, label] of SITES) {
  const f = files.find((x) => x.rel === rel)
  const has = !!f && /s\.categories|categories\.map|categories\.some|c\.name/.test(f.text)
  ok(label + ' 已改用 store.categories', has, rel)
}

console.log('\n=== ⑤ 空数组兜底：下拉不能一个选项都没有 ===')
const npd = files.find((f) => f.rel === 'pages/inbound/NewProductDialog.tsx')
ok('NewProductDialog 有 categories.length > 0 的兜底（既有正确写法，作为参照）', !!npd && /categories\.length > 0/.test(npd.text))

console.log('\n=== ⑥ 两级分类（大分类）已接上 ===')
const dbjs = fs.readFileSync(path.resolve(HERE, '..', 'electron', 'db.js'), 'utf8')
ok('categories 表有 parent 列（DDL）', /parent TEXT DEFAULT ''/.test(dbjs))
ok('迁移 migrateCategoryParent 已注册', /migrateCategoryParent\]/.test(dbjs) || /'分类大分类补列（两级分类）',\s*migrateCategoryParent/.test(dbjs))
const groups = ['竿轮', '线组钩漂', '饵料小药', '渔具装备', '电器工具', '其他']
const missingGroup = groups.filter((g) => !dbjs.includes(g + ':') && !dbjs.includes(g + ' '))
ok('6 个大分类都写进了预填表', missingGroup.length === 0, '缺: ' + missingGroup.join(','))
const bar = files.find((f) => f.rel === 'pages/inventory/InventoryFilterBar.tsx')
ok('库存查询筛选栏有大分类筛选', !!bar && /categoryGroup/.test(bar.text))
const table = files.find((f) => f.rel === 'pages/inventory/InventoryTable.tsx')
ok('库存表格有大分类列', !!table && /TableHead>大分类</.test(table.text))
ok('两处都从 store 的 categories 派生（不另存一份真相）',
  !!bar && !!table && /s\.categories/.test(bar.text) && /s\.categories/.test(table.text))

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
