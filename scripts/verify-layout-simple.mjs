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

console.log('\n=== ④ 账号页不许把内部编号和旧方式摊给用户 ===')
// 真机截图取证：账号页顶上是一大段「4 步操作 + ※忘了密码」散文（约 1/4 屏），
// 一卡片里并排放着「账户登录」和「配对码」两条路，还漏出一句内部编号「（旧①）」。
const acct = strip(read('pages/AccountPage.tsx'))
const cc = strip(read('pages/settings/CloudCard.tsx'))
ok('账号页顶部说明默认收起（help 开关，默认 false）',
  /const \[help, setHelp\] = useState\(false\)/.test(acct))
ok('账号页保留一句白话说清怎么用', /多台电脑共用一个账号/.test(acct))
ok('账号页"看详细步骤"是折叠入口', /看详细步骤/.test(acct))
ok('旧配对码默认收起（legacyPair 开关，默认 false）',
  /const \[legacyPair, setLegacyPair\] = useState\(false\)/.test(cc))
ok('旧配对码只留一个小链接', /有旧的配对码？点这里/.test(cc))
// 只查**内部编号本身**（旧①/旧②…）。不要只匹配「（旧」—— JSX 注释 {/* 配对码（旧方式） */}
// 也含这两个字，但它不渲染给用户，会造成假失败（第一次写就是这么误报的）。
const internalNo = ['旧①', '旧②', '旧③'].filter((s) => cc.includes(s) || acct.includes(s))
ok('内部编号（旧①…）不再漏给用户看', internalNo.length === 0, internalNo.join(','))
const ai = strip(read('components/ai/AiPanel.tsx'))
ok('AI 建议问题收到 3 条且不再写死商品名',
  (ai.match(/^\s*'[^']+？',\s*$/gm) || []).length <= 3 && !/赤刃/.test(ai))

console.log('\n=== ⑤ 开单页：空车也要看得见「收款」这一步 ===')
// 真机截图取证：以前 CartPanel 里写着 `if (items.length === 0) return null`，
// 于是空车时整块消失 —— 开单页只剩一个搜索框、下半屏全白，
// 新人扫第一件货之前完全看不到「合计 / 收款」，也不知道这页最后要干什么。
const ob = strip(read('pages/OutboundPage.tsx'))
const cp = strip(read('pages/outbound/CartPanel.tsx'))
ok('开单页是左右两栏（左选货 / 右清单）', /lg:grid-cols-\[minmax\(0,1fr\)_400px\]/.test(ob))
ok('购物面板钉在右栏（lg:sticky）', /lg:sticky/.test(cp))
ok('空车时购物面板不再整块消失', !/if \(items\.length === 0\) return null/.test(cp))
ok('空车时给出下一步提示（还没加货…）', /还没加货/.test(cp))
ok('空车时收款按钮仍在（灰着）且写明先加货', /收款（先加货）/.test(cp))
ok('标题说老板的话（开单卖货），不再写 FIFO', /开单卖货/.test(ob) && !/先进先出/.test(ob))
ok('开发话术从正文移走（扫码枪长提示已缩短）', !/提示：扫码枪扫条码后回车即选中商品/.test(ob))
ok('今日出入账记录默认收起',
  /const \[showRecords, setShowRecords\] = useState\(false\)/.test(ob) && /\{showRecords && \(/.test(ob))

console.log('\n=== ⑥ 常卖商品置顶（开单页的头号提速点）===')
// owner 2026-09-14 要求「常卖商品置顶」：渔具店天天卖的就是那几样，点一下直接进清单。
// 真机真数据实测过：出来的正是「倍利 / 东哥渔具（主线组）4.5m·3.9m·3.6m 各号数」。
ok('开单页有「常卖商品」置顶区', /常卖商品/.test(ob))
ok('口径是近 90 天', /90 \* 86400000/.test(ob))
ok('只取出库单（type !== out 跳过）', /t\.type !== 'out'/.test(ob))
ok('按笔数降序取前 8 个', /b\[1\] - a\[1\]/.test(ob) && /out\.length >= 8/.test(ob))
ok('只收有货的（没货点进去也开不了单）', /totalStockOf\(id\) <= 0/.test(ob))
ok('只收有价的（没价不能开单）', /cents <= 0/.test(ob))
ok('价格口径 = 零售档价 → 建议价', /tier === 'retail'/.test(ob) && /p\.suggest_price/.test(ob))
ok('点一下就进清单（quickAdd，数量 1）',
  /const quickAdd = \(p: Product, cents: number\)/.test(ob) && /quantity: 1, priceCents: cents/.test(ob))

console.log('\n=== ⑦ 侧栏字号够大 + 入库页说白话 ===')
// owner 原话：「左边的功能页字体大点，太小了现在」。
const sb = strip(read('components/layout/Sidebar.tsx'))
const ib = strip(read('pages/InboundPage.tsx'))
ok('导航项字号升到 text-base（16px，原 14px）', /rounded-lg text-base font-medium/.test(sb))
ok('已无小号导航项残留', !/rounded-lg text-sm font-medium/.test(sb))
ok('侧栏加宽以容纳大字号（w-60，原 w-56）', /'w-60'/.test(sb))
ok('图标不再用半档尺寸 size-4.5', !/size-4\.5/.test(sb))
ok('入库页去掉「USB 扫码枪即插即用」那句仓库话', !/USB 扫码枪即插即用/.test(ib))

console.log('\n=== ⑧ 假导航去重 + 批量导入有正门 + 桌面不摆「拍照」 ===')
// owner 2026-09-14：「桌面端入库困难，库存批量输入数据困难，如果我给你一张 Excel 表格…
// 直接可以批量导入进去，而且电脑上不应该有拍照入库这个功能」。
// 查证：Excel 导入**早就做好了**（/import，带模板 + 逐行校验），只是侧栏和 hub 都没有入口，
// 只有 Ctrl+K 搜得到；而 hub 里有多张卡指向同一个页面（假导航）。
const hubIn = strip(read('pages/InboundHubPage.tsx'))
const hubSt = strip(read('pages/StockHubPage.tsx'))
const imp = strip(read('pages/ImportPage.tsx'))
const ip = strip(read('lib/importParse.ts'))

// ① 批量导入必须能被点到（hub 入口），且真的支持 xlsx
ok('入库 hub 有「批量导入 Excel」入口', /to: '\/import', label: '批量导入 Excel'/.test(hubIn))
ok('库存 hub 有「批量导入 Excel」入口', /to: '\/import', label: '批量导入 Excel'/.test(hubSt))
ok('导入通道支持 .xlsx（exceljs 解析）', /parseXlsxBuffer/.test(ip) && /\.xlsx/.test(imp))
ok('导入有「下载模板」（否则列名对不上）', /下载导入模板/.test(imp))
ok('表头中英文都认（老板的表不用改列名）', /sku编码: 'sku_code'/.test(ip) && /品类: 'category'/.test(ip))

// ② 假导航：hub 的卡片不许一堆指向**同一个 to**。
// ⚠️ 判据按**完整 to**（含查询串）比，不能把 ?filter=low 剥成 /inventory ——
//    带不同查询串是同一页面的**不同视图**（只看低库存 / 只看临期），那是真导航。
//    第一次写就是剥了查询串，于是把 3 个正常视图误报成「/inventory×3」。
const dupRoutes = (src) => {
  const tos = [...src.matchAll(/\{\s*to:\s*'([^']+)'/g)].map((m) => m[1])
  const seen = new Map()
  for (const t of tos) seen.set(t, (seen.get(t) ?? 0) + 1)
  return [...seen.entries()].filter(([, n]) => n > 1).map(([t, n]) => t + '×' + n)
}
const din = dupRoutes(hubIn)
const dst = dupRoutes(hubSt)
ok('入库 hub 没有重复路由的卡片', din.length === 0, din.join(','))
ok('库存 hub 没有重复路由的卡片', dst.length === 0, dst.join(','))

// ③ 桌面端不摆「拍照入库」
ok('入库页的拍照按钮只在触摸设备上出现（canShoot 门控）',
  /const canShoot = /.test(ib) && /maxTouchPoints/.test(ib) && /\{canShoot && \(/.test(ib))
ok('入库页标题改成老板的话（进货入库）', /title="进货入库"/.test(ib))
ok('入库页有「批量导入 Excel」直达按钮', /批量导入 Excel/.test(ib) && /href="#\/import"/.test(ib))

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
