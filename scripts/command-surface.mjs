#!/usr/bin/env node
/**
 * 命令面抽取与三通道一致性检查（真相源）
 *
 * 背景：同一套业务命令被抄了三遍
 *    electron/main.js 的 handle('x', ...)                （桌面 IPC 实现）
 *    electron/preload.cjs 的 CHANNELS 白名单               （渲染进程可调用面）
 *    electron/server.js 的 INVOKE_CHANNELS/WRITE_CHANNELS （HTTP 接口）
 * 三份不一致就会出"桌面能点、手机打不到"这类幽灵问题。
 *
 * ⚠️ 2026-09-16 重写抽取逻辑（上一版在说假话，比没有还危险）：
 *    上一版用懒匹配从注释一路吃到函数，结果**命中第一个注释后就一路扩张**，
 *    把中间的函数体甚至别的注释一起吞进来。实测后果：
 *      · impl 89/180 为空、desc 102/180 为空；
 *      · ai:chat / ai:parseInboundNote / ai:photoDraft 三条共用 checkAiQuota 的说明；
 *      · ai:quota 的说明里吞进了源码。
 *    Agent 按错的说明调用 = 比没文档更糟，所以这一版：
 *      · **按段切分**：每个 handle( 从其下标切到下一个 handle( 的下标（不再赌"空行"）；
 *      · **按块登记注释**：为每个 export function 找"结束位置紧贴它、中间只有空白/行注释"的那一块；
 *      · 新增 **write 标记**（会改账/改库/改本机文件的命令）；
 *      · 新增 **local 标记**（本机专属通道，故意没有服务端实现）。
 *
 * 用法：node scripts/command-surface.mjs                 # 人类可读报告
 *       node scripts/command-surface.mjs --check         # 只做健康检查（红了 exit 1）
 *       node scripts/command-surface.mjs --emit-registry # 生成 electron/commandRegistry.json
 *       node scripts/command-surface.mjs --json          # JSON（供文档生成器用）
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/**
 * 本机专属的**写**通道：只有 IPC 实现、没有服务端实现，所以不在 server.js 的 WRITE_CHANNELS 里。
 * 判定标准（保守）：**会不会改变本机状态**（写库、写文件、改配置、下载/删除模型、启停服务）。
 * 漏标的后果：Agent 以为它是只读的、随手就跑 —— 所以不确定的一律算写。
 */
const LOCAL_WRITE_CHANNELS = [
  // 备份/恢复：动本机磁盘
  'backup:now', 'backup:restore', 'backup:setExtraDir', 'backup:clearExtraDir',
  // 收款码图片：写本机文件
  'payment:saveQr', 'payment:deleteQr',
  // 授权与密钥：改本机授权状态/密钥文件
  'license:activate', 'ai:bindLicense', 'ai:setKey', 'ai:clearKey', 'ai:setProvider',
  'doubao:setKey', 'doubao:clearKey',
  // 官网/联系方式与本机服务开关：改本机配置
  'site:setContact', 'server:toggle', 'server:regenerateToken',
  // 引导状态
  'onboarding:finish', 'onboarding:reset',
  // 云账号/同步：改云端与本机配置
  'cloud:pair', 'cloud:loginAccount', 'cloud:registerAccount', 'cloud:logout',
  'cloud:setCentralMode', 'cloud:restore', 'cloud:syncNow', 'cloud:syncBusinessNow',
  'cloud:backupNow', 'cloud:regenViewLink', 'cloud:resolveSyncConflict', 'cloud:dismissRestore',
  // 知识库/模板应用/反馈：写库或对外发送
  'knowledge:save', 'knowledge:update', 'knowledge:delete', 'template:apply', 'feedback:send',
  // 本地账号
  'user:login', 'user:logout',
  // 更新与模型下载：动磁盘、重启进程
  'update:downloadAndInstall', 'webupdate:restart', 'flags:set', 'flags:refresh',
  'voice:download', 'tts:download', 'kws:download', 'kws:push', 'kws:reset',
]

/**
 * 通道说明表（**人写的**，2026-09-16 补）—— 只在这些通道"从源码里取不到说明"时兜底。
 *
 * 为什么需要它：注册表的说明来自 `commands/*.js` 的 JSDoc，但**只有命令层命令**才有 JSDoc。
 * 另外约 90 条通道走的是别的模块（ai / doubao / voice / tts / kws / cloud / license / server / flags …），
 * 它们天生取不到说明 —— 而这些恰恰是 Agent 最容易误用的（比如 ai:setKey、cloud:restore、flags:set）。
 *
 * 覆盖规则：`commands/*.js` 的 JSDoc **优先**（它贴着代码，改了代码就会跟着变）；
 * 这里只补"没有 JSDoc 的"。所以本表的条目可以随代码演进删除（一旦源码补了注释，本表就不再生效）。
 * 每条都对着 main.js / server.js 的 handler 实际实现写过，不是照名字猜的。
 */
const CHANNEL_DOCS = {
  // ---- AI（本机 Key 与额度，不是账本数据）----
  'ai:status': 'AI 是否可用（有没有 Key、有没有额度、能不能联网）',
  'ai:providers': '可用的大模型 provider 列表',
  'ai:setProvider': '选择当前用哪个 provider',
  'ai:setKey': '保存某个 provider 的 API Key（本机加密存储）',
  'ai:clearKey': '清空本机保存的 API Key',
  'ai:test': '试跑一次 AI 调用，验证 Key 是否有效',
  'ai:transcribe': '语音转文字（本机模型）',
  'ai:analyzePhoto': '图片 → 商品行（本地兜底优先，AI 只做增强）',
  'ai:dailySummary': '一句话经营日报（营业额/毛利/件数 + 异常提示）',
  'ai:insights': 'AI 洞察列表（默认最近 50 条）',
  'ai:history': '本机 AI 调用历史',
  'ai:localUsageStats': '本机 AI 用量统计',
  'ai:gatewayQuota': '云网关额度查询，返回 { allow, message }',
  'ai:gatewayUsage': '云网关最近用量明细（默认最近 20 条）',
  'ai:orchestratorStatus': '统一 AI 出口的状态（有哪些 provider 可用、本地兜底是否就绪）',
  'ai:correctTerm': '纠正识别出来的商品名/规格写法（语音与图片开单用）',
  'ai:bindLicense': '把本机授权与 AI 网关绑定',
  'ai:chat': 'AI 对话（问答 / 改写文案），走统一 AI 出口',
  'ai:photoDraft': '图片 → 入库草稿（拍一张进货单，识别成商品行）',
  'ai:parseInboundNote': '一段文字/备注 → 入库草稿（解析成商品行）',
  'ai:smartSearch': '一句话找商品（本地模糊匹配优先，AI 增强），与账本同源',
  'doubao:status': '豆包是否可用',
  'doubao:setKey': '保存豆包 API Key',
  'doubao:clearKey': '清空豆包 API Key',
  'doubao:chat': '豆包对话（问答/改写）',
  'doubao:analyzeImage': '豆包视觉：图片 → 商品行',
  'doubao:transcribe': '豆包语音转文字',
  // ---- 语音 / 播报 / 唤醒词（本机模型，动磁盘）----
  'voice:status': '语音识别是否就绪（模型在不在、设备可用否）',
  'voice:transcribe': '语音转文字（本机模型）',
  'voice:parseOrder': '一句话文本 → 开单草稿',
  'voice:parseOrderAudio': '语音 → 开单草稿（识别 + 解析一步完成）',
  'voice:download': '下载/更新本机语音识别模型',
  'tts:status': '语音合成是否就绪',
  'tts:speak': '朗读一段文字（播报营业额等）',
  'tts:download': '下载/更新语音合成模型',
  'kws:status': '唤醒词功能是否就绪',
  'kws:push': '送一段音频给唤醒词检测',
  'kws:reset': '重置唤醒词检测状态',
  'kws:download': '下载/更新唤醒词模型',
  // ---- 云账号与同步（会改云端与本机配置）----
  'cloud:status': '云账号/同步状态（登录与否、最后同步时间、待同步条数）',
  'cloud:pair': '用配对码把本机与云端账号绑定',
  'cloud:registerAccount': '注册云账号（手机号 + 验证码）',
  'cloud:loginAccount': '用已注册的云账号登录',
  'cloud:logout': '退出云账号',
  'cloud:syncNow': '立刻做一次快照同步',
  'cloud:syncBusinessNow': '立刻做一次业务数据（按记录）增量同步',
  'cloud:syncConflicts': '列出多端同步冲突',
  'cloud:resolveSyncConflict': '解决一条多端同步冲突（按记录）',
  'cloud:resolveConflict': '解决一条同步冲突',
  'cloud:backupNow': '立刻上传一份整库备份到云端',
  'cloud:listBackups': '列出云端备份（中心库模式下列的是服务端每日备份）',
  'cloud:restore': '用云端备份恢复本机库（会覆盖当前数据，需二次确认）',
  'cloud:dismissRestore': '忽略"云端有更新备份，是否恢复"的提示',
  'cloud:regenViewLink': '重新生成"手机看店"的只读链接',
  'cloud:setCentralMode': '告诉主进程本机当前是不是中心库模式（决定整库上传闸门）',
  'cloud:centralConfig': '取中心库下发的连接配置（地址 / 令牌）',
  // ---- 本机备份（动本机磁盘）----
  'backup:status': '备份状态（上次时间 / 目录 / 大小 / 是否失败）',
  'backup:now': '立刻在本机做一次备份',
  'backup:restore': '用本机备份恢复库（会覆盖当前数据）',
  'backup:list': '列出中心库服务端的每日备份（只有服务端有）',
  'backup:setExtraDir': '设置额外备份目录（同时写一份到 U 盘/共享盘）',
  'backup:clearExtraDir': '清掉"额外备份目录"设置',
  // ---- 授权 ----
  'license:status': '本机授权状态（版本 / 到期 / 机器码）',
  'license:activate': '用激活码激活本机授权',
  'license:quota': '各版本额度（每日 AI 次数等）',
  // ---- 收款码（本机文件）----
  'payment:getQr': '取本机收款码图片',
  'payment:saveQr': '保存收款码图片到本机',
  'payment:deleteQr': '删除本机保存的收款码图片',
  // ---- 价格档 ----
  'priceTier:list': '价格档列表',
  'priceTier:set': '新增/修改一个价格档（按客户等级定价）',
  'priceTier:delete': '删除一个价格档',
  // ---- 商品（缺 JSDoc 的那几条）----
  'product:create': '新增商品（会校验 SKU 额度）',
  'product:list': '商品列表（按关键词过滤，默认最多 300 条）',
  'product:search': '按关键词搜商品（轻量，给下拉与语音用）',
  'data:loadAll': '一次性加载全量基础数据（商品/分类/单位等，桌面首屏用）',
  // ---- 单据（缺 JSDoc 的那几条）----
  'inbound:create': '新建入库单',
  'customer:create': '新增客户',
  'supplier:list': '供应商列表（含欠款）',
  'supplier:create': '新增供应商',
  'supplier:update': '修改供应商资料',
  'supplier:delete': '删除供应商（有采购/付款记录的会拒绝）',
  'stocktake:updateItem': '更新盘点单里的一项（实盘数）',
  'photo:save': '保存商品图片到本机（返回相对文件名）',
  'photo:delete': '删除商品图片（清掉商品的 photo_path，图片文件一并删）',
  // ---- 报表 / 决策（只读）----
  'report:hotSellers': '热销榜（近 N 天，默认 30，最多 90）',
  'clearance:get': '清仓建议（滞销/临期怎么处理，只读）',
  'pricing:get': '定价建议（只读，给价格区间，不自动改价）',
  // ---- 本机服务与更新 ----
  'server:status': '本机局域网/看店服务的运行状态（端口、地址、开关）',
  'server:toggle': '开/关本机局域网看店服务',
  'server:regenerateToken': '重新生成"手机看店"访问令牌（旧链接立即失效）',
  'app:info': '本机信息（数据库路径、备份目录、版本、上次备份时间）',
  'app:openExternal': '用系统浏览器打开一个 https 链接',
  'site:contact': '取官网/联系方式（出厂默认 + 本机覆盖）',
  'site:setContact': '改本机官网/联系方式（换客服微信不必发版）',
  'update:check': '检查有没有新的安装包（走 electron-updater）',
  'update:downloadAndInstall': '下载并安装新版安装包',
  'webupdate:status': '热更状态（现在跑的是哪版、有没有已就绪的）',
  'webupdate:check': '立刻检查有没有新的前端/口径层热更',
  'webupdate:restart': '重启进程让已就绪的热更生效（约 2 秒）',
  'flags:status': '每个功能开关的有效值与来源（服务端关 / 本机 / 服务端开 / 出厂默认）',
  'flags:set': '改本机功能开关（true / false / null=恢复上级）',
  'flags:refresh': '立刻去取服务端下发的开关（这一台）',
  'feedback:send': '把意见反馈发到官方（自动附本机日志末尾几行）',
  // ---- 命令自省（Agent 的入口）----
  'commands:list': '列出全部命令（可按组或关键词过滤）',
  'commands:describe': '查一条命令的说明与示例',
  'commands:invoke': '按名字执行任意命令 —— Agent 的通用入口',
  // ---- 知识库 ----
  'knowledge:list': '知识库列表/搜索',
  'knowledge:save': '新增一条知识库记录',
  'knowledge:update': '修改一条知识库记录',
  'knowledge:delete': '删除一条知识库记录',
}

/**
 * 从一个 handler 段里推断它对应哪个命令层实现 —— **只在毫无歧义时才认**。
 *
 * 这个函数改了三版，每一版都被真实数据打回来，值得记下来：
 *   v1「取第一个 commands.x(」→ ai:chat 的说明变成"检查今日额度"（认成了它先调的帮手 checkAiQuota）
 *   v2「有 commands.x 取最后一个，否则单表达式箭头才认裸调用」→ ai:chat 又认成了 recordAiUsage
 *   v3（现在）**统计段内所有命令层调用（点号 + 裸调用），只有一个才认，否则返回 null 不猜。**
 *
 * 事实很朴素：像 ai:chat / ai:photoDraft 这种 handler 是"记账式"包裹
 * （先 checkAiQuota、后 recordAiUsage，中间调的是 ai.js/orchestrator 而不是命令层），
 * 用正则**根本认不出它是哪条命令** —— 与其猜错（说明串台，比没有说明更糟），不如不猜：
 * 返回 null，说明由 CHANNEL_DOCS 兜底（那是人写的、对着 handler 核过的）。
 */
function inferImpl(seg, knownFns) {
  const names = new Set()
  for (const m of seg.matchAll(/\b(?:cmds|commands)\.(\w+)\s*\(/g)) names.add(m[1])
  for (const m of seg.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) if (knownFns.has(m[1])) names.add(m[1])
  return names.size === 1 ? [...names][0] : null
}

/**
 * 桌面专属通道（2026-09-16 逐条核对过）：
 *   main.js 注册了、**server.js 没有**、**也不在 `src/lib/api.ts` 的 LOCAL_ONLY_CHANNELS 里**、
 *   而且**渲染层从不调用**（grep 过 src/）。
 * 结论：它们是**只有桌面机可达**的通道（多数是历史遗留，已被统一 AI 出口取代）。
 * 为什么要登记：不登记的话它们会被报成"只有 IPC 没有 HTTP（中心库模式下打不到）"这种告警，
 * 而那是**误报**（渲染层根本不调）。
 * ⚠️ 将来若有界面要用其中任何一条，**必须同时**把它加进 `src/lib/api.ts` 的 LOCAL_ONLY_CHANNELS，
 *    否则中心库模式下会静默 404（就是 2026-09-14 那 62 个通道的病）。
 */
const DESKTOP_ONLY_CHANNELS = [
  'ai:gatewayUsage', 'ai:insights', 'ai:orchestratorStatus', 'commands:describe',
  'doubao:analyzeImage', 'doubao:chat', 'doubao:clearKey', 'doubao:setKey', 'doubao:status',
  'kws:reset', 'license:quota', 'unit:allowsDecimal',
]

/**
 * 实现是**循环注册**的通道：main.js 里写成 `channel: 'voice:download'` 再统一挂载，
 * 静态抽取看不到 `handle('voice:download', …)` 字面量 —— 所以别把它报成"preload 放行但没实现"。
 * 这是抽取器的已知盲区，不是缺口。
 */
const DYN_REGISTERED_CHANNELS = ['voice:download', 'tts:download', 'kws:download']

/**
 * 有实现但 **preload 未放行、渲染层也没调用** → 渲染层实际拿不到它。疑似遗留。
 * 不删（怕误伤别处引用），登记备查。
 */
const KNOWN_UNREACHABLE_CHANNELS = ['cloud:resolveConflict']

/**
 * 说明**以人写的表为准**的通道：它的 impl 是"共用的帮手"（一个 JSDoc 描述不了两条通道），
 * 比如 photo:delete 的实现是 updateProduct（删图片=改 photo_path），
 * 拿 updateProduct 的 JSDoc 当它的说明就是张冠李戴。实测只有这一处。
 */
const DESC_OVERRIDES = new Set(['photo:delete'])

/** 1) main.js：按段切分每个 handle(...) —— 从它自己的下标切到下一个 handle( 的下标 */
function fromMain(knownFns) {
  const s = R('electron/main.js')
  const re = /(?:^|\n)[ \t]*(?:const\s+\w+\s*=\s*)?(?:handle|ipcMain\.handle)\(\s*'([^']+)'/g
  const marks = [...s.matchAll(re)]
  const out = new Map()
  marks.forEach((m, i) => {
    const seg = s.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : s.length)
    out.set(m[1], {
      impl: inferImpl(seg, knownFns),
      usesP: /\(\s*d\s*,\s*p/.test(seg.slice(0, 120)),
    })
  })
  return out
}

/** 2) preload.cjs：CHANNELS 白名单 */
function fromPreload() {
  const s = R('electron/preload.cjs')
  const m = /CHANNELS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(s)
  if (!m) return new Set()
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
}

/**
 * 从一个 `{` 开始，按**配平括号**切出整块（跳过字符串与注释）。
 *
 * 为什么不能用懒匹配 `/\{([\s\S]*?)\n\}/`：它会在**第一个**「换行 + 右花括号」处停下 ——
 * 而那个位置到底是不是本块的结尾，取决于别人怎么写代码。
 * 2026-09-16 实测就栽在这上面：`restRoutes` 那 14 条 REST 路由**根本不是被解析出来的**，
 * 而是 INVOKE_CHANNELS 的懒匹配**越界吞进去**的副产品；我在 server.js 里加了一个函数
 * （它的 `}` 恰好落在更前面），副产品就消失了 → restRoutes 变成 0 条，指南断言立刻红。
 * 这类"取决于别人怎么写代码"的解析必须换掉。
 */
function sliceBalanced(s, openIdx) {
  let depth = 0
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i]
    if (ch === '{') { depth++; continue }
    if (ch === '}') { depth--; if (depth === 0) return s.slice(openIdx + 1, i); continue }
    if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < s.length && s[i] !== ch) { if (s[i] === '\\') i++; i++ }
      continue
    }
    if (ch === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (ch === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue }
  }
  return ''
}

/** 取出 `const NAME = { ... }` 的块内容（按配平括号，不赌花括号位置） */
function objectBlock(s, name) {
  const at = s.indexOf(name)
  if (at < 0) return ''
  const open = s.indexOf('{', at)
  return open < 0 ? '' : sliceBalanced(s, open)
}

/** 3) server.js：INVOKE_CHANNELS（HTTP 面）+ WRITE_CHANNELS（权威的读/写划分）+ ROUTES（只读 REST）
 *  knownFns：命令层导出过的函数名集合 —— 用来认**裸调用**。
 *  server.js 里 analytics/search 是从命名空间解构出来直接用的（`analyticsOverview(d)`），
 *  只认 `cmds.` 前缀会把这些通道的 impl 全判成空（实测 analytics:* 5 条就是这么漏的）。
 */
function fromServer(knownFns) {
  const s = R('electron/server.js')
  const block = objectBlock(s, 'INVOKE_CHANNELS')
  const out = new Map()
  if (block) {
    const re = /'([^']+)'\s*:\s*(?:async\s+)?\(([^)]*)\)\s*=>\s*/g
    const marks = [...block.matchAll(re)]
    marks.forEach((m, i) => {
      const seg = block.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : block.length)
      out.set(m[1], { impl: inferImpl(seg, knownFns), usesP: /\(\s*d\s*,\s*p/.test('(' + m[2] + ')') })
    })
  }
  const wm = /WRITE_CHANNELS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(s)
  const writes = new Set(wm ? [...wm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [])
  // 只读 REST 路由：正经从 ROUTES 表里取（原来靠越界吞，见 sliceBalanced 的注释）
  const restRoutes = [...objectBlock(s, 'const ROUTES').matchAll(/'(\/api\/[A-Za-z0-9_/-]+)'\s*:/g)].map((m) => m[1])
  return { invokes: out, writes, restRoutes }
}

/**
 * 4) 命令实现的 JSDoc 描述 —— **按块登记 + 只认紧贴的那一块**。
 *
 * 这里踩过一个很深的坑：用"从注释懒匹配到函数"的做法是**不可靠**的 ——
 * 当最靠前的那个块注释的结束符后面还有代码时，懒匹配会**继续往后扩张**，
 * 直到找到"后面只剩空白"的那个注释为止，于是把中间的函数体甚至别的注释一起吞进来。
 * 表现：文件里第一个块注释变成了很多函数的说明。
 * 所以改成：先把所有块注释按位置登记，再为每个 export function 找
 * "结束位置紧贴它、中间只有空白或 // 行注释"的**那一块**。
 */
function jsdocIndex() {
  const dir = path.join(ROOT, 'electron/commands')
  const idx = new Map()
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue
    const s = fs.readFileSync(path.join(dir, f), 'utf8')
    const blocks = [...s.matchAll(/\/\*\*[\s\S]*?\*\//g)].map((b) => ({
      end: b.index + b[0].length,
      text: b[0],
    }))
    for (const m of s.matchAll(/export\s+function\s+(\w+)/g)) {
      let desc = ''
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].end > m.index) continue
        const between = s.slice(blocks[i].end, m.index)
        if (!/^(?:\s|\/\/[^\n]*)*$/.test(between)) continue
        desc = blocks[i].text
          .replace(/^\/\*\*|\*\/$/g, '')
          .split('\n')
          .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
          // 丢掉 JSDoc 标签行（@param/@returns/...）：说明是给人/Agent 看的一句话，
          // 混进 `@param {number} p.productId` 只会让它变噪音（实测 stock:transfer 就是这样）。
          .filter((l) => l && !l.startsWith('@'))
          .join(' ')
          .slice(0, 200)
        break
      }
      idx.set(m[1], { file: f, desc })
    }
  }
  return idx
}

/**
 * 5) 本机专属通道（`src/lib/api.ts` 的 LOCAL_ONLY_PREFIXES / LOCAL_ONLY_CHANNELS）。
 * 为什么注册表要知道它：这些通道**故意**没有服务端实现（问的是"这台电脑"），
 * 不标出来的话"只有 IPC、没有 HTTP"会误报七十多条，真正的不一致就被淹掉了。
 */
function fromLocalOnly() {
  const s = R('src/lib/api.ts')
  const prefixes = [...((s.match(/LOCAL_ONLY_PREFIXES\s*=\s*\[([^\]]*)\]/) || [null, ''])[1]).matchAll(/'([^']+)'/g)].map((m) => m[1])
  const block = (s.match(/LOCAL_ONLY_CHANNELS\s*=\s*\[([\s\S]*?)\]\s*as const/) || [null, ''])[1]
  const exact = new Set([...block.matchAll(/'([a-zA-Z]+:[A-Za-z]+)'/g)].map((m) => m[1]))
  return { prefixes, exact, isLocal: (n) => prefixes.some((p) => n.startsWith(p)) || exact.has(n) }
}

// ⚠️ 顺序有讲究：先建 JSDoc 索引（它给出"命令层导出过哪些函数名"），
//    再用这个集合去认 handler 里的裸调用 —— 反过来会踩 TDZ。
const docs = jsdocIndex()
const knownFns = new Set(docs.keys())
const main = fromMain(knownFns)
const pre = fromPreload()
const srv = fromServer(knownFns)
const localOnly = fromLocalOnly()
const allNames = [...new Set([...main.keys(), ...pre, ...srv.invokes.keys(), ...srv.restRoutes])].sort()
const writes = new Set([...srv.writes, ...LOCAL_WRITE_CHANNELS])

const rows = allNames.map((name) => {
  const a = main.get(name)
  const b = srv.invokes.get(name)
  const impl = (a && a.impl) || (b && b.impl) || null
  const jsdoc = impl ? docs.get(impl) : null
  const jsdocDesc = (jsdoc && jsdoc.desc) || ''
  // 说明优先级：**少数张冠李戴的以表为准** → 否则源码 JSDoc 优先 → 再兜底表
  const desc = DESC_OVERRIDES.has(name)
    ? (CHANNEL_DOCS[name] || jsdocDesc)
    : (jsdocDesc || CHANNEL_DOCS[name] || '')
  const fromTable = DESC_OVERRIDES.has(name) ? !!CHANNEL_DOCS[name] : (!jsdocDesc && !!CHANNEL_DOCS[name])
  return {
    name,
    isRest: name.startsWith('/api/'),
    group: name.includes(':') ? name.split(':')[0] : (name.startsWith('/api/') ? 'REST 路径' : '(无前缀)'),
    ipc: !!a,
    http: !!b,
    preloadOk: pre.has(name),
    local: localOnly.isLocal(name) || DESKTOP_ONLY_CHANNELS.includes(name),
    desktopOnly: DESKTOP_ONLY_CHANNELS.includes(name),
    impl,
    desc,
    descFrom: fromTable ? 'table' : (desc ? 'jsdoc' : ''),
    srcFile: (jsdoc && jsdoc.file) || '',
    write: writes.has(name),
  }
})

// ---------- 一致性判定 ----------
const cmdRows = rows.filter((r) => !r.isRest)
// ⚠️ "只有 IPC、没有 HTTP" 要**排除本机专属**（含桌面专属）：它们故意没有服务端实现。
const onlyIpc = cmdRows.filter((r) => r.ipc && !r.http && !r.local).map((r) => r.name)
/**
 * "只有 HTTP、没有 IPC" **不是缺陷**：桌面端与手机/中心库对同一份数据用的是不同通道名
 * （比如 analytics:* 只给服务端/手机用）。所以它只作参考，不进 --check 的失败项。
 */
const onlyHttp = cmdRows.filter((r) => !r.ipc && r.http).map((r) => r.name)
const ipcNotInPreload = cmdRows.filter((r) => r.ipc && !r.preloadOk && !KNOWN_UNREACHABLE_CHANNELS.includes(r.name)).map((r) => r.name)
const preloadNotImpl = [...pre].filter((n) => !main.has(n) && !DYN_REGISTERED_CHANNELS.includes(n)).sort()
const noImpl = cmdRows.filter((r) => !r.impl).map((r) => r.name)
const noDesc = cmdRows.filter((r) => !r.desc).map((r) => r.name)
const writeCount = cmdRows.filter((r) => r.write).length
const desktopOnlyCount = cmdRows.filter((r) => r.desktopOnly).length

/**
 * 说明串台的判据：**两条命令共用一个 desc，但 impl 不同** = 抽取或映射错了。
 * （共用同一个 impl 是合法的：一个实现挂两个通道名。）
 */
const descShareMismatch = (() => {
  const by = new Map()
  for (const r of cmdRows) {
    if (!r.desc) continue
    if (!by.has(r.desc)) by.set(r.desc, new Set())
    by.get(r.desc).add(r.impl)
  }
  return [...by.entries()]
    .filter(([, impls]) => impls.size > 1)
    .map(([desc, impls]) => ({ desc: desc.slice(0, 60), impls: [...impls] }))
})()

function healthReport() {
  console.log('命令面总览')
  console.log('  总命令数        : ' + cmdRows.length)
  console.log('  IPC 实现        : ' + main.size)
  console.log('  HTTP 实现       : ' + srv.invokes.size)
  console.log('  preload 白名单  : ' + pre.size)
  console.log('  有说明(desc)    : ' + (cmdRows.length - noDesc.length) + ' / ' + cmdRows.length)
  console.log('  能定位实现(impl): ' + (cmdRows.length - noImpl.length) + ' / ' + cmdRows.length)
  console.log('  写命令(write)   : ' + writeCount)
  console.log('  桌面专属        : ' + desktopOnlyCount + '（服务端没有、渲染层也不调 → 只能在桌面机上用）')
  console.log('')
  const show = (t, arr) => console.log('  ' + t.padEnd(30) + (arr.length ? arr.length + ' 条: ' + arr.slice(0, 8).join(', ') + (arr.length > 8 ? ' …' : '') : '无'))
  console.log('!! 真正的问题（进 --check 的失败项）')
  show('只有 IPC、没有 HTTP 且非本机', onlyIpc)
  show('有 IPC 实现但 preload 没放行', ipcNotInPreload)
  show('preload 放行但没有实现', preloadNotImpl)
  console.log('')
  console.log('!! 参考信息（不算失败）')
  show('只有 HTTP、没有 IPC（手机/中心库专用，正常）', onlyHttp)
  show('桌面专属（已登记，见 DESKTOP_ONLY_CHANNELS）', DESKTOP_ONLY_CHANNELS.filter((n) => cmdRows.some((r) => r.name === n)))
  show('有实现但 preload 未放行、渲染层也不调（遗留备查）', KNOWN_UNREACHABLE_CHANNELS)
  show('循环注册（抽取器盲区，非缺口）', DYN_REGISTERED_CHANNELS)
  console.log('')
  console.log('!! 说明质量')
  show('说明串台（同一说明、不同实现）', descShareMismatch.map((d) => d.impls.join('+')))
  show('没有说明', noDesc)
}

if (process.argv.includes('--emit-registry')) {
  const out = path.join(ROOT, 'electron/commandRegistry.json')
  const payload = {
    // 由 scripts/command-surface.mjs --emit-registry 生成，勿手改；
    // 一致性由 scripts/verify-command-api.mjs 与 scripts/gen-command-doc.mjs --check 守护
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    source: 'main.js(IPC) + server.js(HTTP/WRITE_CHANNELS/ROUTES) + preload.cjs(白名单) + api.ts(本机专属) + commands/*.js(JSDoc)',
    total: cmdRows.length,
    restRoutes: srv.restRoutes,
    writes: cmdRows.filter((r) => r.write).map((r) => r.name).sort(),
    health: {
      withDesc: cmdRows.length - noDesc.length,
      withImpl: cmdRows.length - noImpl.length,
      descShareMismatch: descShareMismatch.length,
    },
    commands: cmdRows.map((r) => ({
      name: r.name,
      group: r.group,
      desc: r.desc,
      impl: r.impl,
      ipc: r.ipc,
      http: r.http,
      preload: r.preloadOk,
      rest: false,
      // write=true：**会改账 / 改库 / 改本机文件或配置** —— Agent 与 CLI 据此决定要不要二次确认
      write: r.write,
      // local=true：**问的是本机**（故意没有服务端实现），只能在桌面机上调
      local: r.local,
      // 说明是哪来的：'jsdoc'（源码注释，改了会跟着变）/ 'table'（人写的兜底表）。
      // 导出它是为了能审计"哪些命令的说明还只是兜底"（本轮就是这么找出补 JSDoc 的清单的）。
      descFrom: r.descFrom,
    })),
  }
  fs.writeFileSync(out, JSON.stringify(payload, null, 1))
  console.log('已写 electron/commandRegistry.json：' + cmdRows.length + ' 条命令，写命令 ' + writeCount + ' 条，有说明 ' + (cmdRows.length - noDesc.length) + ' 条')
  process.exit(0)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), total: rows.length, commands: rows, inconsistencies: { onlyIpc, onlyHttp, ipcNotInPreload, preloadNotImpl, noImpl, noDesc, descShareMismatch } }, null, 1))
  process.exit(0)
}

healthReport()

if (process.argv.includes('--check')) {
  const problems = []
  if (descShareMismatch.length) problems.push('说明串台 ' + descShareMismatch.length + ' 处（同一说明挂在不同实现上）')
  if (ipcNotInPreload.length) problems.push('有 IPC 实现但 preload 没放行 ' + ipcNotInPreload.length + ' 条')
  if (preloadNotImpl.length) problems.push('preload 放行但没有实现 ' + preloadNotImpl.length + ' 条')
  if (onlyIpc.length) problems.push('只有 IPC、没有 HTTP ' + onlyIpc.length + ' 条（中心库模式下手机/Agent 打不到）')
  console.log('')
  if (problems.length) {
    console.log('!! 不通过：')
    for (const p of problems) console.log('   - ' + p)
    process.exit(1)
  }
  console.log('OK：命令面一致，说明没有串台')
}
