// 机器校验：界面扁平化的两条硬约束（owner 2026-09-14「布局太乱、太专业」）
//
// ① **同一个指标只能有一个判据**。此前代码里 `<` 与 `<=` 并存，于是同一屏出现
//    「顶栏 28 缺货」和「首页低库存 42」——那不是审美问题，是系统在自相矛盾。
// ② **首页与设置不许再堆回"给开发者看的"东西**：重复卡片、6 个与侧栏重复的快捷入口、
//    以及壁纸/行业模板/数据位置这类装机才看一次的区块。
//
// 跑法：node scripts/verify-layout-simple.mjs
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
const strip = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(e.name)) files.push({ rel: path.relative(SRC, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') })
  }
}
walk(SRC)
const find = (rel) => files.find((f) => f.rel === rel)
const read = (rel) => find(rel)?.text ?? ''

console.log('扫描 ' + files.length + ' 个 src 下的 .ts/.tsx 文件\n')

console.log('=== ① 「低库存」只有一个判据 ===')
const sv = read('lib/stockVitals.ts')
ok('lib/stockVitals.ts 存在', sv.length > 0)
ok('导出 isLowStock', /export function isLowStock/.test(sv))
ok('导出 countLowStock', /export function countLowStock/.test(sv))
ok('判据是 `<`（刚好卡在预警线上还有的卖，不算缺货）', /total\s*<\s*\(minStock/.test(sv))
for (const rel of ['components/layout/TopBar.tsx', 'components/vitals/VitalsBar.tsx', 'pages/DashboardPage.tsx', 'pages/InventoryPage.tsx']) {
  ok(rel + ' 用了唯一判据 countLowStock', /countLowStock/.test(strip(read(rel))))
}
// 负向守卫：任何文件里都不许再出现 `<= (… min_stock …)` 这种第二套判据
const dupSites = files
  .filter((f) => /totalStockOf\([^)]*\)\s*<=\s*\([^)]*min_stock/.test(strip(f.text)))
  .map((f) => f.rel)
ok('全仓不再出现 `<= min_stock` 的第二套判据', dupSites.length === 0, dupSites.join(', '))

console.log('\n=== ② 首页不许再自相矛盾 / 堆重复区块 ===')
const vit = strip(read('components/vitals/VitalsBar.tsx'))
const dash = strip(read('pages/DashboardPage.tsx'))
// 与顶栏打架的那张「未连接云端」卡（它看 cloud.paired，顶栏看中心库配置）
ok('体征条不再自己判云端连接（删掉了与顶栏打架的那张卡）', !/cloud\.paired|未连接云端/.test(vit))
ok('体征条不再用「库存水位/百分比」这套内部指标', !/库存水位|低于 30% 变红/.test(vit))
ok('体征条给出的是白话两件事（该补什么货 / 店里的货）', /该补什么货/.test(vit) && /店里的货/.test(vit))
// 6 个与侧栏重复的快捷入口
ok('首页删掉了与侧栏重复的 6 个快捷入口', !/to: '\/inbound-hub', label: '入库'/.test(dash))
ok('首页有「更多经营数据」折叠入口', /更多经营数据/.test(dash))
ok('折叠默认收起（用 more 开关而非直接铺开）', /const \[more, setMore\] = useState\(false\)/.test(dash) && /\{more && \(/.test(dash))
ok('开单/入库是主按钮（size="lg"）', (dash.match(/size="lg"/g) || []).length >= 2)
ok('首页标题是白话问候，不再只有「今日经营」', /今天生意怎么样/.test(dash))
// 今日经营数字只出现一处（曾经体征条 + 大卡 + 小结 三处重复）
const moneyCount = (dash.match(/formatPrice\(todaySales\.revenue\)/g) || []).length
ok('首页「今日营业额」只渲染一处', moneyCount === 1, '实际 ' + moneyCount + ' 处')

console.log('\n=== ③ 设置页把「装机才看一次」的东西收进高级 ===')
const set = strip(read('pages/SettingsPage.tsx'))
ok('有「高级设置」折叠开关', /高级设置（桌面壁纸 \/ 行业模板 \/ 数据位置）/.test(set))
ok('折叠状态存在且默认收起', /const \[adv, setAdv\] = useState\(false\)/.test(set))
ok('桌面壁纸在 adv 之内', set.indexOf('{adv && (') < set.indexOf('<WallpaperCard />'))
ok('行业模板在 adv 之内', set.indexOf('{adv && (') < set.indexOf('<IndustryTemplateCard />'))
ok('数据位置在 adv 之内（且位于第二个 adv 块里）', (set.match(/\{adv && \(/g) || []).length >= 2)

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
