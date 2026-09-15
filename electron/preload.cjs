// preload：contextIsolation 下的最小桥接面，channel 白名单防任意调用
const { contextBridge, ipcRenderer } = require('electron')

// ---- 中心库配置的**启动补齐**（P0 2026-09-15）----
// 为什么必须在 preload 做：`src/lib/api.ts` 在**模块加载时**就同步决定"连本机还是连中心库"，
// 而配置的事实源现在在主进程文件（dataDir/central.json）。preload 早于页面脚本执行，正好在这一刻补齐。
// 只补**缺失**的情况，不覆盖当次修改：
//   · 正常启动：localStorage 里已有 → 不动（避免与用户当次的修改打架）
//   · 被清站点数据 / 换了存储 / 新机器：补上 → 收银机不会"静默退回本地模式"（看错账）
// 实测（2026-09-15，独立 profile 探针）：sandbox:true 的 preload 能读写 localStorage，且**页面读得到**。
try {
  const cfg = ipcRenderer.sendSync('cloud:centralSync') || {}
  if (cfg.url && cfg.token && !localStorage.getItem('fi-central-url')) {
    localStorage.setItem('fi-central-url', cfg.url)
    localStorage.setItem('fi-central-token', cfg.token)
  }
} catch { /* 读不到就按老行为：localStorage 原样 */ }

// ---- B 通道（P1 前端热更）的**渲染自检** ----
// 为什么必须放在 preload：它属于**壳**（A 通道），任何 dist 版本里都有这段代码 ——
// 所以哪怕热更包本身写坏了、页面根本没渲染出来，这段探针照样会跑并如实报告失败。
// 主进程据此决定"转正（以后不再回退）"还是"下次启动自动退回上一版"。
// 判据刻意选得笨：#root 有没有子节点 —— 它只证明"JS 跑起来了、React 挂上了"，
// 不掺业务语义，也就不会因为后端出错而误判成"前端坏了"。
try {
  let settled = false
  const report = () => {
    if (settled) return
    try {
      const root = document.getElementById('root')
      if (root && root.childElementCount > 0) {
        settled = true
        ipcRenderer.send('web:healthy')
        return true
      }
    } catch { /* 探针自己出错就当没确认，主进程还有第二路 DOM 检查 */ }
    return false
  }
  if (!report()) {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (report()) { clearInterval(timer); return }
      if (Date.now() - t0 > 10_000) {
        clearInterval(timer)
        settled = true
        ipcRenderer.send('web:broken', { reason: '首页 10 秒内未挂载（#root 无子节点）' })
      }
    }, 250)
  }
} catch { /* 忽略 */ }

const CHANNELS = new Set([
  'data:loadAll',
  'product:create',
  'product:update',
  'product:batchUpdate',
  'product:delete',
  'product:mark',
    'product:expiring',
  'category:list',
  'category:listWithCount',
  'category:create',
  'category:rename',
  'category:delete',
  'category:move',
  'category:setParent',
  'unit:list',
  'unit:create',
  'unit:update',
  'unit:delete',
  'unit:move',
  'unit:allowsDecimal',
  'template:list',
  'template:apply',
  'inbound:create',
  'outbound:confirm',
  'outbound:checkout',
  'outbound:return',
  'outbound:exchange',
  'supplier:create',
  'supplier:update',
  'supplier:delete',
  'supplier:pay',
  'supplier:payments',
  'user:list',
  'user:create',
  'user:update',
  'user:delete',
  'user:login',
  'user:logout',
  'user:current',
  'user:staffLoginEnabled',
  'user:setStaffLogin',
  'stocktake:create',
  'stocktake:updateItem',
  'stocktake:complete',
  'stocktake:submit',
  'import:batch',
  // 库位调拨（2026-09-15）：备货出库/换库位专用，不写 transactions
  'stock:transfer',
  'stock:byLocation',
  'customer:create',
  'customer:update',
  'customer:delete',
  'customer:list',
  'customer:statement',
  'payment:record',
  'expense:create',
  'expense:update',
  'expense:delete',
  'waste:create',
  'waste:list',
  'waste:summary',
  'part:set',
  'part:setMany',
  'part:list',
  'part:all',
  'kit:list',
  'kit:get',
  'kit:save',
  'receipt:register',
  'receipt:list',
  'receipt:reconcile',
  'kit:delete',
  'po:create',
  'po:list',
  'po:detail',
  'po:receive',
  'po:cancel',
  'priceTier:set',
  'priceTier:delete',
  'priceTier:list',
  'backup:now',
  'backup:restore',
  'backup:status',
  'backup:setExtraDir',
  'backup:clearExtraDir',
  'audit:list',
  'supplier:statement',
  'photo:save',
  'photo:delete',
  'payment:getQr',
  'payment:saveQr',
  'payment:deleteQr',
  'ai:status',
  'ai:providers',
  'ai:setProvider',
  'ai:setKey',
  'ai:clearKey',
  'ai:test',
  'ai:dailySummary',
  'ai:chat',
  'ai:parseInboundNote',
  'ai:quota',
  'ai:gatewayQuota',
  'ai:gatewayUsage',
  'ai:localUsageStats',
  'ai:bindLicense',
  'ai:transcribe',
  'ai:history',
  'ai:insights',
  'knowledge:list',
  'knowledge:save',
  'knowledge:update',
  'knowledge:delete',
  'doubao:status',
  'doubao:setKey',
  'doubao:clearKey',
  'doubao:analyzeImage',
  'doubao:chat',
  'ai:smartSearch',
  'ai:orchestratorStatus',
  'ai:analyzePhoto',
  'voice:status',
  'voice:transcribe',
  'voice:parseOrder',
  'voice:parseOrderAudio',
  'voice:download',
  'tts:status',
  'tts:speak',
  'tts:download',
  'kws:status',
  'kws:download',
  'kws:push',
  'kws:reset',
  'app:openExternal',
  'app:info',
  'feedback:send',
  'site:contact',
  'site:setContact',
  'server:status',
  'server:toggle',
  'server:regenerateToken',
  'update:check',
  'update:downloadAndInstall',
  // B 通道（P1 前端热更）：状态 / 手动检查 / 重启生效（都是"问本机"的问题）
  'webupdate:status',
  'webupdate:check',
  'webupdate:restart',
  // 功能开关（P3）：状态 / 本机改 / 立刻取服务端下发（都是"这台机器算不算开"的问题）
  'flags:status',
  'flags:set',
  'flags:refresh',
  'license:status',
  'license:activate',
  'license:quota',
  'onboarding:status',
  'onboarding:reset',
  'onboarding:finish',
  'clearance:get',
  'pricing:get',
  'cloud:status',
  'cloud:pair',
  'cloud:syncNow',
  'cloud:backupNow',
  'cloud:listBackups',
  'cloud:restore',
  'cloud:regenViewLink',
  'cloud:registerAccount',
  'cloud:loginAccount',
  'cloud:centralConfig',
  // 上报「本机是不是中心库模式」：主进程据此在中心库模式下禁止整库上传（方案A 2026-09-14）
  'cloud:setCentralMode',
  'cloud:logout',
  'cloud:dismissRestore',
  // 阶段2.3：多端同步冲突列出/逐条解决/立即同步（main.js 已注册；此前漏放行，前端调用会被拒）
  'cloud:syncConflicts',
  'cloud:resolveSyncConflict',
  'cloud:syncBusinessNow',
  // 命令接口（命令台）
  'commands:list',
  'commands:describe',
  'commands:invoke',
])

contextBridge.exposeInMainWorld('fi', {
  invoke(channel, payload) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`未知通道: ${channel}`))
    return ipcRenderer.invoke(channel, payload)
  },
  // 订阅模型下载进度（voice:download / tts:download / kws:download 触发），返回取消订阅函数
  onVoiceProgress(callback) {
    const listener = (_e, data) => callback(data)
    ipcRenderer.on('voice:progress', listener)
    return () => ipcRenderer.removeListener('voice:progress', listener)
  },
  onTtsProgress(callback) {
    const listener = (_e, data) => callback(data)
    ipcRenderer.on('tts:progress', listener)
    return () => ipcRenderer.removeListener('tts:progress', listener)
  },
  onKwsProgress(callback) {
    const listener = (_e, data) => callback(data)
    ipcRenderer.on('kws:progress', listener)
    return () => ipcRenderer.removeListener('kws:progress', listener)
  },
  // 自动更新事件订阅（update:available 等由 updater.js 主进程发出）
  // 修复 2026-08-31：此前缺这三个订阅，UpdateBanner 因 api.onUpdateAvailable 不存在静默返回，
  // 导致「检测到新版本但下载/安装面板不弹出」
  onUpdateAvailable(callback) {
    const listener = (_e, data) => callback(data)
    ipcRenderer.on('update:available', listener)
    return () => ipcRenderer.removeListener('update:available', listener)
  },
  onUpdateNotAvailable(callback) {
    const listener = (_e, data) => callback(data)
    ipcRenderer.on('update:not-available', listener)
    return () => ipcRenderer.removeListener('update:not-available', listener)
  },
  onUpdateProgress(callback) {
    const listener = (_e, data) => callback(data)
    ipcRenderer.on('update:progress', listener)
    return () => ipcRenderer.removeListener('update:progress', listener)
  },
  // B 通道（P1 前端热更）：护栏④"用户可见"靠这两个订阅 ——
  // 主进程把"新前端已就绪"推给界面，界面显示「点这里立即生效」，**绝不静默替换**。
  onWebUpdateReady(callback) {
    const listener = (_e, data) => callback(data)
    ipcRenderer.on('webupdate:ready', listener)
    return () => ipcRenderer.removeListener('webupdate:ready', listener)
  },
  onWebUpdateProgress(callback) {
    const listener = (_e, data) => callback(data)
    ipcRenderer.on('webupdate:progress', listener)
    return () => ipcRenderer.removeListener('webupdate:progress', listener)
  },
})
