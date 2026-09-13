// 机器校验：商品「子类」必须在库存查询里**看得见、搜得到、可复用**，
// 而且**不许**为了"整齐"把它做成受控字典（那会丢掉老板真实的 150 个子类值）。
//
// ---------- 背景（2026-09-13 生产库实测）----------
//
// 事实 A：老板填了子类，界面上看不见。
//   本机库 324 个商品里 152 个填了 sub_category（47%），
//   但 InventoryTable.tsx **一处都没渲染它** —— 库存查询里一个子类都看不到。
//   同一个字段在 InboundPage / OutboundPage 的搜索里反而有 → 三处口径不一致。
//
// 事实 B：初版诊断把它判成"自由文本污染"，那个判定是错的。
//   依据"152 行填了 150 个不同值"。逐条看原值后确认那是**真实的渔具子类词典**：
//     鱼竿 → 中通竿/前打竿/插节竿/海竿/溪流竿/矶竿/筏竿/路亚竿/雷强竿
//     鱼钩 → 伊势尼/丸世/千又/袖钩/海夕/新关东/爆炸钩/曲柄钩/朝天钩
//     渔轮 → 纺车轮/水滴轮/鼓轮/微型轮
//   实测"用 ≥2 次"的子类只有 2 个（太空豆、新关东），其余 148 个各用 1 次 ——
//   所以"150 个不同值"只说明**同一子类下常常只有一件货**，不说明数据脏。
//
// 事实 C：所以正解是"可复用"，不是"受控"。
//   datalist 给建议（已用过的值不必重打）+ 仍允许自由输入（真值一个字不丢）。
//
// 跑法：node scripts/verify-product-identity.mjs
//       node scripts/verify-product-identity.mjs --db <data.db>   # 附带实测数字（只读，不作为判据）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SRC = path.join(REPO, 'src')

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
    else if (/\.(ts|tsx)$/.test(e.name)) {
      files.push({ rel: path.relative(SRC, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') })
    }
  }
}
walk(SRC)
const read = (rel) => files.find((f) => f.rel === rel)?.text ?? ''
// 去掉注释行后再判断 —— 第一版诊断就是被"注释里提到的名字"误导过
const stripComments = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const code = (rel) => stripComments(read(rel))

console.log('扫描 ' + files.length + ' 个 src 下的 .ts/.tsx 文件\n')

console.log('=== ① 子类候选只有一处来源 ===')
const lib = read('lib/subCategories.ts')
ok('src/lib/subCategories.ts 存在', lib.length > 0)
ok('导出 subCategoryOptions', /export function subCategoryOptions/.test(lib))
ok('说明了"为什么不做成受控下拉"（防止后来者又把它改成 Select）',
  /受控/.test(lib) && /伊势尼|纺车轮/.test(lib))

console.log('\n=== ② 三处消费方都从这一处取，不各写一份 ===')
const CONSUMERS = [
  ['pages/InventoryPage.tsx', '库存查询筛选'],
  ['pages/inbound/NewProductDialog.tsx', '新建商品表单'],
  ['pages/inventory/EditProductDialog.tsx', '编辑商品表单'],
]
for (const [rel, label] of CONSUMERS) {
  ok(label + ' import 了 subCategoryOptions',
    /import\s*\{[^}]*subCategoryOptions[^}]*\}\s*from\s*'@\/lib\/subCategories'/.test(code(rel)), rel)
}

console.log('\n=== ③ 库存查询里看得见（真缺陷 A：填了也看不见）===')
const table = code('pages/inventory/InventoryTable.tsx')
ok('表头有「子类」列', /<TableHead>子类<\/TableHead>/.test(table))
ok('每行渲染 p.sub_category', /\{p\.sub_category/.test(table))
// 这一条防"以后又把它删掉"：子类必须真的出现在表格文件里
ok('子类不再缺席库存表格（去掉注释后仍然出现）', table.includes('sub_category'))

console.log('\n=== ④ 库存查询里搜得到（与入库/出库口径拉齐）===')
const page = code('pages/InventoryPage.tsx')
ok('关键词搜索字段里含 p.sub_category', /p\.sku_code,\s*p\.barcode,\s*p\.brand,\s*p\.model,\s*p\.category,\s*p\.sub_category/.test(page))
ok('按子类过滤生效', /subCategory !== ALL && \(p\.sub_category \?\? ''\) !== subCategory/.test(page))
ok('重置筛选会清掉子类', /setSubCategory\(ALL\)/.test(page))
ok('子类进了 CSV 导出表头', /品类,子类,品牌/.test(page))
ok('子类进了 CSV 导出行', /p\.category,\s*p\.sub_category \?\? '',/.test(page))

console.log('\n=== ⑤ 高级筛选里的子类下拉 ===')
const bar = code('pages/inventory/InventoryFilterBar.tsx')
ok('筛选栏有子类下拉（Select）', /value=\{subCategory\}/.test(bar) && /subCategories\.map/.test(bar))
ok('子类计入"高级筛选"角标', /subCategory !== allValue \? 1 : 0/.test(bar))
ok('搜索框提示语写明能搜子类', /搜索SKU\/品牌\/型号\/子类\/条码/.test(bar))

console.log('\n=== ⑥ 可复用但不受控（真值一个字都不能丢）===')
for (const [rel, label] of [
  ['pages/inbound/NewProductDialog.tsx', '新建商品'],
  ['pages/inventory/EditProductDialog.tsx', '编辑商品'],
]) {
  const t = code(rel)
  ok(label + '的子类是 datalist（给建议）', /<datalist id="sub-category-choices-/.test(t))
  ok(label + '的输入框用 list= 挂上候选', /list="sub-category-choices-/.test(t))
  // 自由输入必须保留：Input 同时有 value 与 onChange
  ok(label + '的输入框仍可自由输入（保留 onChange）', /value=\{form\.subCategory\}|value=\{form\.sub_category\}/.test(t) && /onChange=/.test(t))
  // 反例守卫：子类不许被改成受控 <Select>
  const block = t.slice(t.indexOf('子类') - 200 < 0 ? 0 : t.indexOf('子类') - 200, t.indexOf('子类') + 700)
  ok(label + '的子类没有被改成受控 Select', !/<Select[^>]*sub[Cc]ategory/.test(block) && !/subCategoryChange/.test(block))
}

console.log('\n=== ⑦ 没有为子类新增"受控字典"层（不新增真相来源）===')
const dbjs = fs.readFileSync(path.join(REPO, 'electron', 'db.js'), 'utf8')
ok('db.js 没有新建 sub_categories 表', !/CREATE TABLE[^;]*sub_categories/i.test(dbjs))
const serverJs = fs.readFileSync(path.join(REPO, 'electron', 'server.js'), 'utf8')
const preload = fs.readFileSync(path.join(REPO, 'electron', 'preload.cjs'), 'utf8')
ok('没有新增 subCategory 写通道（server.js）', !/subCategory:/.test(serverJs))
ok('没有新增 subCategory 写通道（preload.cjs）', !/subCategory:/.test(preload))

console.log('\n=== ⑧ 展开行 colSpan 与主表列数一致（加了列忘改 colSpan 会错行）===')
const hStart = table.indexOf('<TableHeader>')
const hEnd = table.indexOf('</TableHeader>')
const mainHeader = table.slice(hStart, hEnd)
// <TableHead[\s>] 不会误匹配 <TableHeader>
const colCount = (mainHeader.match(/<TableHead[\s>]/g) || []).length
const spanM = table.match(/<TableCell colSpan=\{(\d+)\}/)
const span = spanM ? Number(spanM[1]) : NaN
ok('主表列数可数出来', colCount > 0, '列数=' + colCount)
ok('展开行 colSpan = 列数 - 2（前两列是勾选与展开箭头）',
  Number.isFinite(span) && span === colCount - 2, '列数=' + colCount + ' colSpan=' + span)
ok('主表含子类列后共 13 列', colCount === 13, '实际 ' + colCount)

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)

// ---------- 附带实测（只读；数字是证据，不作为判据，缺库不算失败）----------
const dbArgIdx = process.argv.indexOf('--db')
const dbPath = dbArgIdx > -1
  ? process.argv[dbArgIdx + 1]
  : path.join(process.env.APPDATA || '', 'fishing-inventory', 'data.db')
if (dbPath && fs.existsSync(dbPath)) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const total = db.prepare('SELECT COUNT(*) c FROM products').get().c
    const filled = db.prepare("SELECT COUNT(*) c FROM products WHERE sub_category IS NOT NULL AND TRIM(sub_category) <> ''").get().c
    const distinct = db.prepare("SELECT COUNT(DISTINCT TRIM(sub_category)) c FROM products WHERE sub_category IS NOT NULL AND TRIM(sub_category) <> ''").get().c
    const reused = db.prepare("SELECT COUNT(*) c FROM (SELECT TRIM(sub_category) v FROM products WHERE sub_category IS NOT NULL AND TRIM(sub_category) <> '' GROUP BY TRIM(sub_category) HAVING COUNT(*) >= 2)").get().c
    db.close()
    console.log('\n---- 实测（' + dbPath + '）----')
    console.log('商品 ' + total + ' 个；填了子类 ' + filled + ' 个；不同子类值 ' + distinct + ' 个；用 ≥2 次的 ' + reused + ' 个')
    console.log('读法：不同值≈填充数 说明"同一子类下常常只有一件货"，不说明数据脏 —— 见本文件顶部事实 B')
  } catch (e) {
    console.log('\n（附带实测跳过：' + e.message + '）')
  }
} else {
  console.log('\n（附带实测跳过：找不到库文件）')
}

process.exit(fail === 0 ? 0 : 1)
