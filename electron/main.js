// 主进程：窗口生命周期 + 数据库装配 + IPC 注册 + 退出收尾
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from 'electron'
import * as Sentry from '@sentry/electron/main'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openDatabase, finalCheckpoint, listInsights, saveInsight, updateInsight, deleteInsight, aiUsageStats, listAiUsageLog } from './db.js'
import * as commands from './commands.js'
import * as ai from './ai.js'
import * as aiQuota from './aiQuota.js' // P0 计费阀门：AI 统一计费入口
import * as voiceOrderService from './voiceOrderService.js' // P1-3 语音开单
import * as doubao from './doubao.js'
// ai-orchestrator（1.0）：统一 AI 出口，本地兜底优先，前端不再散调
import * as orchestrator from './ai-orchestrator.js'
import * as voice from './voice.js'
import * as tts from './tts.js'
import * as kws from './kws.js'
import { MODEL_NAME, ensureModel } from './modelManager.js'
import { TTS_MODEL_NAME, ensureTtsModel } from './ttsModelManager.js'
import { KWS_MODEL_NAME, ensureKwsModel } from './kwsModelManager.js'
import { backupNow, backupNowAsync, scheduleDailyBackup, restoreBackup, backupStatus, loadBackupConfig, saveBackupExtraDir } from './backup.js'
import * as feedback from './feedback.js'
import { createInventoryServer } from './server.js'
import { createPhotoStore } from './photo.js'
import { initAutoUpdater, checkForUpdates, downloadAndInstall } from './updater.js'
import { loadLicense, activateLicense, verifyLicenseCode, machineFingerprint, saveLevelToDb, quotaStatus, planFor } from './license.js'
import { initCloud, pairWithCloud, syncSnapshot, uploadBackup, listCloudBackups, restoreFromCloud, regenViewLink, getCloudState, stopScheduler as stopCloudScheduler, exitSnapshot as exitCloudSnapshot, registerAccount as cloudRegisterAccount, loginAccount as cloudLoginAccount, logoutAccount as cloudLogoutAccount, resolveConflict, dismissRestoreHold } from './cloud.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 商品图片走自定义协议 fi-img://photo/<文件名>：file:// 页面直接 <img src> 指 %APPDATA% 绝对路径会被
// file 协议拦；data URL 图片一多内存吃不消。standard+secure 让它能像 https 一样当图片源用。
// 必须在 app ready 之前注册特权（模块顶层即可）
protocol.registerSchemesAsPrivileged([
  { scheme: 'fi-img', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

// 单实例：工控机/门店电脑上防止双击开出两个进程写同一个库
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const dataDir = path.join(app.getPath('appData'), 'fishing-inventory')
const dbPath = path.join(dataDir, 'data.db')
const backupDir = path.join(dataDir, 'backup')
// 崩溃日志：主进程漏网异常/渲染进程崩溃的留痕文件（与 backup-error.log 平级）
const crashLogPath = path.join(dataDir, 'crash.log')
/** 写一行崩溃日志（失败静默，不干扰主流程） */
function logCrash(label, err) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const line = `[${new Date().toISOString()}] ${label}: ${err?.stack || err?.message || String(err)}\n`
    fs.appendFileSync(crashLogPath, line)
  } catch { /* 日志写不进去就算了 */ }
}
// 主进程兜底保险：任何漏网的同步/异步异常都留痕 + 提示，绝不无声闪退
// 注意：这是"最后一道保险"，业务层 try/catch 照常做；这里只保证不崩
process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err)
  // 弹窗告知（主窗口在就挂主窗口，不在就系统级提示）
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '程序遇到问题',
        message: '程序遇到一个意外错误，已记录到崩溃日志，不会影响你的数据。',
        detail: `错误信息：${err?.message ?? err}\n日志位置：${crashLogPath}`,
      })
    } catch { /* 弹窗失败忽略 */ }
  }
})
process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)))
})
// 第二备份位置配置（U 盘/网盘目录）：{ extraDir }，见 backup.js
const backupConfigPath = path.join(dataDir, 'backup-config.json')
const getExtraDir = () => loadBackupConfig(backupConfigPath).extraDir
// 商品图片目录：<productId>.<ext>，读写与路径校验全在 photo.js（无 Electron 依赖，可单测）
const photoStore = createPhotoStore(path.join(dataDir, 'images'))
ai.initAi(dataDir)
aiQuota.initAiQuota(dataDir) // P0：计费模块与 AI 同目录初始化
doubao.initDoubao(dataDir)
// 离线语音识别模型目录：首次启动后可经 voice:download 通道下载到本机
const voiceModelDir = path.join(dataDir, 'models', MODEL_NAME)
voice.initVoice(voiceModelDir)
// 模型下载中的进行中 Promise，防止渲染端连点触发并发下载
let voiceDownloading = null
// 离线语音合成（TTS）与唤醒词（KWS）模型：与识别模型平级目录、独立状态、独立下载通道
const ttsModelDir = path.join(dataDir, 'models', TTS_MODEL_NAME)
tts.initTts(ttsModelDir)
let ttsDownloading = null
const kwsModelDir = path.join(dataDir, 'models', KWS_MODEL_NAME)
kws.initKws(kwsModelDir)
let kwsDownloading = null

/** 注册"模型下载 + 进度推送"通道的公共骨架（voice/tts/kws 三模型同一模式） */
function registerModelDownload({ channel, progressEvent, isDownloading, setDownloading, ensure, dir, onDone }) {
  ipcMain.handle(channel, async (e) => {
    if (isDownloading()) return isDownloading()
    const p = ensure(dir, (prog) => {
      if (!e.sender.isDestroyed()) {
        e.sender.send(progressEvent, {
          file: prog.file,
          received: prog.received,
          total: prog.total,
          percent: Math.min(100, Math.round((prog.received / prog.total) * 100)),
        })
      }
    })
      .then((r) => {
        if (r.ok) onDone?.()
        return r
      })
      .finally(() => setDownloading(null))
    setDownloading(p)
    return p
  })
}

let db = null
let mainWindow = null
// 手机看店：局域网只读 HTTP 服务，app ready 且 db 打开后创建
let inventoryServer = null
// 恢复备份后为 true：旧 db 连接的视图已与被覆盖的库文件脱节，
// 退出收尾必须跳过备份/checkpoint，否则会把旧内存视图写回刚恢复的文件
let restoring = false

// 备份失败统一上报：写 backup-error.log 留痕（与退出备份同一模式）+ 弹错误框
function reportBackupError(label, e) {
  console.error(`[backup] ${label}:`, e)
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'backup-error.log'),
      `[${new Date().toISOString()}] ${label}: ${e.stack || e.message}\n`,
    )
  } catch {
    // 日志写不进去就算了，不再抛错
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '备份失败',
      message: `${label}`,
      detail: `错误信息：${e.message}\n失败记录已写入：${path.join(app.getPath('userData'), 'backup-error.log')}`,
    })
  }
}

function registerIpc() {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (_e, payload) => fn(db, payload ?? {}))

  handle('data:loadAll', (d) => commands.loadAll(d))
  handle('product:create', (d, p) => { const r = commands.createProduct(d, p); voiceOrderService.refreshVoiceOrderCache(); return r }) // P1-3：商品变更后刷新语音热词
  handle('product:update', (d, p) => { const r = commands.updateProduct(d, p.id, p); voiceOrderService.refreshVoiceOrderCache(); return r })
  handle('product:batchUpdate', (d, p) => { const r = commands.batchUpdateProducts(d, p); voiceOrderService.refreshVoiceOrderCache(); return r })
  handle('product:delete', (d, p) => { const r = commands.deleteProduct(d, p.id, p.operator ?? null); voiceOrderService.refreshVoiceOrderCache(); return r })
  handle('product:mark', (d, p) => commands.markProduct(d, p))
  handle('product:expiring', (d, p) => commands.expiringProducts(d, p))
  // 通用版：分类管理
  handle('category:list', (d) => commands.listCategories(d))
  handle('category:listWithCount', (d) => commands.listCategoriesWithCount(d))
  handle('category:create', (d, p) => commands.createCategory(d, p))
  handle('category:rename', (d, p) => commands.renameCategory(d, p.id, p))
  handle('category:delete', (d, p) => commands.deleteCategory(d, p.id, p.operator))
  handle('category:move', (d, p) => commands.moveCategory(d, p.id, p.dir))
  // 通用版：单位管理
  handle('unit:list', (d) => commands.listUnits(d))
  handle('unit:create', (d, p) => commands.createUnit(d, p))
  handle('unit:update', (d, p) => commands.updateUnit(d, p.id, p))
  handle('unit:delete', (d, p) => commands.deleteUnit(d, p.id, p.operator))
  handle('unit:move', (d, p) => commands.moveUnit(d, p.id, p.dir))
  handle('unit:allowsDecimal', (d, p) => commands.unitAllowsDecimal(d, p.name))
  // 通用版：行业模板
  handle('template:list', () => commands.listTemplates())
  handle('template:apply', (d, p) => commands.applyIndustryTemplate(d, p))
  handle('inbound:create', (d, p) => commands.createInbound(d, p))
  handle('outbound:confirm', (d, p) => commands.confirmOutbound(d, p))
  handle('outbound:checkout', (d, p) => commands.confirmCheckout(d, p))
  handle('outbound:return', (d, p) => commands.createReturn(d, p))
  handle('outbound:exchange', (d, p) => commands.createExchange(d, p))
  handle('supplier:create', (d, p) => commands.createSupplier(d, p))
  handle('supplier:update', (d, p) => commands.updateSupplier(d, p.id, p))
  handle('supplier:delete', (d, p) => commands.deleteSupplier(d, p.id))
  handle('supplier:pay', (d, p) => commands.paySupplier(d, p))
  handle('supplier:payments', (d, p) => commands.supplierPayments(d, p))
  // 员工账号（v0.1）
  handle('user:list', (d) => commands.listUsers(d))
  handle('user:create', (d, p) => commands.createUser(d, p, p?.operator))
  handle('user:update', (d, p) => commands.updateUser(d, p.id, p, p?.operator))
  handle('user:delete', (d, p) => commands.deleteUser(d, p.id, p?.operator))
  handle('user:login', (d, p) => commands.login(d, p))
  handle('user:logout', (d) => commands.logout(d))
  handle('user:current', (d) => commands.currentUser(d))
  handle('user:staffLoginEnabled', (d) => commands.staffLoginEnabled(d))
  handle('user:setStaffLogin', (d, p) => commands.setStaffLogin(d, p.on, p?.operator))
  handle('stocktake:create', (d, p) => commands.createStockTake(d, p))
  handle('stocktake:updateItem', (d, p) => commands.updateStockTakeItem(d, p))
  handle('stocktake:complete', (d, p) => commands.completeStockTake(d, p.takeId))
  handle('stocktake:submit', (d, p) => commands.submitStockTake(d, p))
  handle('import:batch', (d, p) => { const r = commands.importBatch(d, p); voiceOrderService.refreshVoiceOrderCache(); return r })
  // 赊账包：客户档案 / 还款 / 对账单
  handle('customer:create', (d, p) => commands.createCustomer(d, p))
  handle('customer:update', (d, p) => commands.updateCustomer(d, p))
  handle('customer:delete', (d, p) => commands.deleteCustomer(d, p))
  handle('customer:list', (d) => commands.listCustomers(d))
  handle('customer:statement', (d, p) => commands.customerStatement(d, p))
  handle('payment:record', (d, p) => commands.recordPayment(d, p))
  // 支出记账：记/改/删（列表随 data:loadAll 的 expenses 下发）
  handle('expense:create', (d, p) => commands.createExpense(d, p))
  handle('expense:update', (d, p) => commands.updateExpense(d, p))
  handle('expense:delete', (d, p) => commands.deleteExpense(d, p))
  // 报损登记：记损耗 / 列表 / 汇总（活饵死亡、饵料报废进成本报表）
  handle('waste:create', (d, p) => commands.createWaste(d, p))
  handle('waste:list', (d, p) => commands.listWastes(d, p ?? {}))
  handle('waste:summary', (d, p) => commands.wasteSummary(d, p ?? {}))
  // 旧版配节（兼容保留）：设配节关系 / 查配节 / 批量设配节
  handle('part:set', (d, p) => commands.setPart(d, p))
  handle('part:setMany', (d, p) => commands.setPartsMany(d, p))
  handle('part:list', (d, p) => commands.partsOf(d, p ?? {}))
  handle('part:all', (d, p) => commands.allParts(d, p ?? {}))
  // 套装（v2.2）：列表/详情/保存/删除
  handle('kit:list', (d) => commands.listKits(d))
  handle('kit:get', (d, p) => commands.getKit(d, p ?? {}))
  handle('kit:save', (d, p) => commands.saveKit(d, p))
  handle('kit:delete', (d, p) => commands.deleteKit(d, p ?? {}))
  // 收款对账（v3.0）：登记实收 / 查登记 / 日结对账
  handle('receipt:register', (d, p) => commands.registerReceipt(d, p ?? {}))
  handle('receipt:list', (d, p) => commands.listReceipts(d, p ?? {}))
  handle('receipt:reconcile', (d, p) => commands.reconcileReceipt(d, p ?? {}))
  // 采购订单：建单/列表/详情/收货入库/取消
  handle('po:create', (d, p) => commands.createPurchaseOrder(d, p))
  handle('po:list', (d, p) => commands.listPurchaseOrders(d, p))
  handle('po:detail', (d, p) => commands.purchaseOrderDetail(d, p))
  handle('po:receive', (d, p) => commands.receivePurchaseOrder(d, p))
  handle('po:cancel', (d, p) => commands.cancelPurchaseOrder(d, p))
  // 多级定价：档次价设/删/查（商品列表的各档价格随 data:loadAll 的 priceTiers 下发）
  handle('priceTier:set', (d, p) => commands.setPriceTier(d, p))
  handle('priceTier:delete', (d, p) => commands.deletePriceTier(d, p))
  handle('priceTier:list', (d, p) => commands.getPriceTiers(d, p))
  handle('backup:now', (d) => backupNowAsync(d, dbPath, backupDir, getExtraDir()))
  // 备份状态：最近备份时间/份数/第二位置可用性/超期提醒（设置页用）
  handle('backup:status', () => backupStatus({ dbPath, backupDir, configPath: backupConfigPath }))
  // 选第二备份位置（如 U 盘）：每次备份后同一份再复制过去；选完直接回最新状态
  ipcMain.handle('backup:setExtraDir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择第二备份位置（如 U 盘或网盘目录）',
      properties: ['openDirectory'],
    })
    if (canceled || filePaths.length === 0) return { ok: false, cancelled: true }
    saveBackupExtraDir(backupConfigPath, filePaths[0])
    return { ok: true, ...backupStatus({ dbPath, backupDir, configPath: backupConfigPath }) }
  })
  ipcMain.handle('backup:clearExtraDir', () => {
    saveBackupExtraDir(backupConfigPath, null)
    return { ok: true, ...backupStatus({ dbPath, backupDir, configPath: backupConfigPath }) }
  })
  // 操作日志查询（可按 action 筛选）；供应商对账单
  handle('audit:list', (d, p) => commands.auditLog(d, p))
  handle('supplier:statement', (d, p) => commands.supplierStatement(d, p))
  // 商品图片：渲染端已压好（选图后在 canvas 缩到 800px、JPEG 0.85 转 base64），这里只写盘，
  // 返回相对文件名，前端再调 product:update 把它挂到 photo_path 上
  ipcMain.handle('photo:save', (_e, p) => ({
    ok: true,
    path: photoStore.save(p?.productId, p?.base64, p?.ext ?? 'jpg'),
  }))
  // 删图一次做完两件事：删 images 目录里的文件 + 清掉商品上的 photo_path
  ipcMain.handle('photo:delete', (_e, p) => {
    photoStore.remove(p?.productId)
    commands.updateProduct(db, p?.productId, { photo_path: null })
    return { ok: true }
  })
  // 收款码：微信/支付宝收款码图片（个体户柜台贴的码），存 dataDir/payment-qr/{wx,ali}.jpg
  // 手机端开单选微信/支付宝时展示给顾客扫，解决"手机记了账但钱没实时对账"的问题
  const paymentQrDir = path.join(dataDir, 'payment-qr')
  ipcMain.handle('payment:getQr', () => {
    const readQr = (name) => {
      try {
        const p = path.join(paymentQrDir, name)
        if (fs.existsSync(p)) return `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}`
      } catch { /* 读不到当没配置 */ }
      return null
    }
    return { wx: readQr('wx.jpg'), ali: readQr('ali.jpg') }
  })
  ipcMain.handle('payment:saveQr', (_e, p) => {
    const name = p?.type === 'wx' ? 'wx.jpg' : p?.type === 'ali' ? 'ali.jpg' : null
    if (!name || !p?.base64) return { ok: false, error: '参数不对' }
    try {
      fs.mkdirSync(paymentQrDir, { recursive: true })
      fs.writeFileSync(path.join(paymentQrDir, name), Buffer.from(String(p.base64).split(',')[1] || p.base64, 'base64'))
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  })
  ipcMain.handle('payment:deleteQr', (_e, p) => {
    const name = p?.type === 'wx' ? 'wx.jpg' : p?.type === 'ali' ? 'ali.jpg' : null
    if (!name) return { ok: false }
    try { fs.rmSync(path.join(paymentQrDir, name), { force: true }) } catch {}
    return { ok: true }
  })
  // 从备份恢复：选文件 → 二次确认 → 覆盖 data.db → 重启应用让新库生效
  ipcMain.handle('backup:restore', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择要恢复的备份文件',
      defaultPath: backupDir,
      filters: [
        { name: '数据库备份', extensions: ['db', 'bak'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (canceled || filePaths.length === 0) return { ok: false, cancelled: true }
    const backupPath = filePaths[0]
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '从备份恢复',
      message: '确定要用这份备份替换当前的全部数据吗？',
      detail:
        `当前店里的数据会被备份里的内容整个替换掉。` +
        `替换前系统会自动把当前数据留底（data.db.pre-restore.bak），选错了还能找回来。` +
        `恢复完成后软件会自动重启。\n\n备份文件：${backupPath}`,
      buttons: ['取消', '确认恢复并重启'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response !== 1) return { ok: false, cancelled: true }
    restoreBackup(db, backupPath, dbPath)
    restoring = true
    app.relaunch()
    app.exit(0)
    // app.exit 同步终止进程，正常走不到这里
    return { ok: true }
  })
  // AI 助手（BYOK，Kimi）：密钥管理与一句话日报，全部失败静默降级
  handle('ai:status', () => ai.aiStatus())
  handle('ai:providers', () => ai.aiProviders())
  handle('ai:setProvider', (d, p) => ai.setProvider(p.provider))
  handle('ai:setKey', (d, p) => ai.setApiKey(p.key))
  handle('ai:clearKey', () => ai.clearApiKey())
  handle('ai:test', () => ai.testConnection())
  handle('ai:dailySummary', (d, p) => ai.dailySummary(p.stats ?? p))
  // AI 助手对话（v0.1 起全版本开放）：默认走官方网关，按版本每日额度（普通版 5 次/天免费试用）；
  // 自备 Key（BYOK）的厂商不限次。超额提示升级。
  handle('ai:chat', async (d, p) => {
    if (!ai.usingOfficialGateway()) {
      return ai.agentChat(p.messages ?? [])
    }
    const quota = commands.checkAiQuota(db, 'chat')
    if (!quota.allow) return { ok: false, reason: quota.message }
    const r = await ai.agentChat(p.messages ?? [])
    if (r?.ok) commands.recordAiUsage(db, 'chat')
    return r
  })
  // AI 视觉识别（拍照识别进货单）：v3.0 每日额度控制（普通20/进阶100/大师不限）
  handle('ai:parseInboundNote', async (d, p) => {
    const quota = commands.checkAiQuota(db, 'vision')
    if (!quota.allow) return { ok: false, reason: quota.message }
    const r = await ai.parseInboundNote(p)
    if (r?.ok) commands.recordAiUsage(db, 'vision')
    return r
  })
  handle('ai:quota', () => commands.aiQuotaStatus(db, 'vision'))
  // ---- P0 计费阀门：余额/流水/激活码绑定/本地用量统计（额度卡数据源） ----
  handle('ai:gatewayQuota', () => aiQuota.gatewayQuota())
  handle('ai:gatewayUsage', (d, p) => aiQuota.gatewayUsage(p?.limit ?? 20))
  handle('ai:localUsageStats', () => {
    try {
      if (!db) return { ok: false, reason: 'db-not-ready' }
      return { ok: true, stats: aiUsageStats(db), recent: listAiUsageLog(db, 20) }
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e) }
    }
  })
  // 老用户补绑激活码（P0 前激活的没有留激活码原文）：本地验签通过才存 + 网关绑定迁移
  handle('ai:bindLicense', async (d, p) => {
    try {
      const code = String(p?.code ?? '').trim()
      const v = verifyLicenseCode(code, machineFingerprint())
      if (!v.valid) return { ok: false, error: v.error }
      return await aiQuota.bindLicense(code)
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  })
  handle('ai:transcribe', (d, p) => ai.transcribeAudio(p))
  // ---- 1.0 orchestrator 统一出口：本地兜底优先，断网/无 KEY 不哑 ----
  handle('ai:smartSearch', (d, p) => orchestrator.smartSearch(p?.text, p))
  handle('ai:orchestratorStatus', () => orchestrator.orchestratorStatus())
  handle('ai:analyzePhoto', (d, p) => orchestrator.analyzePhoto(p))
  // 豆包视觉模型 2.1：分析店面照片 → 区位布局 / 货架品类识别
  handle('doubao:status', () => doubao.doubaoStatus())
  handle('doubao:setKey', (d, p) => doubao.setDoubaoKey(p.key))
  handle('doubao:clearKey', () => doubao.clearDoubaoKey())
  handle('doubao:analyzeImage', (d, p) => doubao.analyzeImage(p))
  handle('doubao:chat', (d, p) => doubao.doubaoChat(p.message))
  // 离线语音识别（sherpa-onnx 本地模型）：模型就绪时渲染端走 voice:transcribe（PCM 本地识别），
  // 未就绪时渲染端自动回退 ai:transcribe（base64 云端识别），两条通道并存互不干扰
  handle('voice:status', () => ({ ...voice.voiceStatus(), downloading: !!voiceDownloading }))
  handle('voice:transcribe', (d, p) => voice.transcribePcm(p))
  // ---- P1-3 语音开单：文本/音频 → 开单草稿（不落库，确认卡确认后才走 outbound:checkout） ----
  handle('voice:parseOrder', (d, p) => voiceOrderService.parseOrderText(p?.text ?? ''))
  handle('voice:parseOrderAudio', (d, p) => voiceOrderService.parseOrderAudio(p ?? {}))
  // 下载模型：进度经 webContents.send('voice:progress') 推送，渲染端 preload 订阅。
  // 下载成功立刻预加载识别器，首次按住说话不用等 1s 模型加载
  registerModelDownload({
    channel: 'voice:download',
    progressEvent: 'voice:progress',
    isDownloading: () => voiceDownloading,
    setDownloading: (p) => { voiceDownloading = p },
    ensure: ensureModel,
    dir: voiceModelDir,
    onDone: () => voice.preloadRecognizer(),
  })
  // 离线语音合成（TTS）：主进程合成 wav，渲染进程播放；失败时前端自动回退系统语音
  handle('tts:status', () => ({ ...tts.ttsStatus(), downloading: !!ttsDownloading }))
  ipcMain.handle('tts:speak', (_e, p) => tts.synthesizeAsync(p ?? {}))
  registerModelDownload({
    channel: 'tts:download',
    progressEvent: 'tts:progress',
    isDownloading: () => ttsDownloading,
    setDownloading: (p) => { ttsDownloading = p },
    ensure: ensureTtsModel,
    dir: ttsModelDir,
    onDone: () => tts.preloadTts(),
  })
  // 唤醒词（KWS）：渲染进程常驻推 16kHz PCM 小块，主进程流式检测「小杜小杜」
  handle('kws:status', () => ({ ...kws.kwsStatus(), downloading: !!kwsDownloading }))
  handle('kws:push', (d, p) => kws.pushPcm(p))
  handle('kws:reset', () => kws.resetKws())
  registerModelDownload({
    channel: 'kws:download',
    progressEvent: 'kws:progress',
    isDownloading: () => kwsDownloading,
    setDownloading: (p) => { kwsDownloading = p },
    ensure: ensureKwsModel,
    dir: kwsModelDir,
    // KWS 引擎等渲染端开启监听后首次推送时懒加载，不在下载完成时预加载
  })
    handle('ai:history', (d, p) => ai.aiHistory(p.limit ?? 50))
  handle('ai:insights', (d, p) => ai.aiInsights(p.limit ?? 50))
  // 知识库管理（ai_insights 表 CRUD）：查看/搜索/新增/编辑/删除
  handle('knowledge:list', (d, p) => listInsights(d, p ?? {}))
  handle('knowledge:save', (d, p) => saveInsight(d, p.kind, p.content, { tags: p.tags ?? null, source: '手动' }))
  handle('knowledge:update', (d, p) => updateInsight(d, p.id, p))
  handle('knowledge:delete', (d, p) => deleteInsight(d, p.id))
  // 外部链接（如 Kimi 开放平台）用系统浏览器打开，仅放行 https
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url)
  })
  // 意见反馈：POST 到飞书机器人 webhook（地址由设置页填写、随反馈一起提交）；
  // 日志指向备份错误日志，反馈时自动附末尾几行
  feedback.initFeedback({
    logFile: path.join(app.getPath('userData'), 'backup-error.log'),
    version: app.getVersion(),
    feedbackDir: dataDir,
  })
  handle('feedback:send', (d, p) => feedback.sendFeedback(p))
  // 手机看店：局域网只读服务的状态/开关/换 token（inventoryServer 在 app ready 后创建）
  ipcMain.handle('server:status', () => inventoryServer?.status() ?? { enabled: false, running: false })
  ipcMain.handle('server:toggle', (_e, p) =>
    inventoryServer ? inventoryServer.setEnabled(!!p?.enabled) : { enabled: false, running: false },
  )
  ipcMain.handle('server:regenerateToken', () => inventoryServer?.regenerateToken() ?? null)
  // 自动更新通道：检查 / 下载安装（挂掉静默降级）
  ipcMain.handle('update:check', async () => {
    try { return await checkForUpdates() } catch { return { checkedAt: new Date().toISOString() } }
  })
  ipcMain.handle('update:downloadAndInstall', async () => {
    try { await downloadAndInstall() } catch (e) { throw new Error(e?.message ?? '下载失败') }
  })
  // 授权通道：状态查询 / 激活码验证 / 配额状态
  ipcMain.handle('license:status', () => {
    try {
      const lic = loadLicense(dataDir)
      if (db) saveLevelToDb(db, lic.activated ? lic.level : 'free')
      return lic
    } catch { return { activated: false, level: 'free', expiresAt: null, machineId: machineFingerprint(), daysLeft: null } }
  })
  ipcMain.handle('license:activate', async (_e, p) => {
    try {
      const r = activateLicense(dataDir, p?.code ?? '')
      if (r.ok && db) saveLevelToDb(db, r.license.level)
      // P0 计费阀门：激活成功 → 保存激活码原文（safeStorage 加密）并绑到网关账户（余额迁移）
      // 网关不可达不阻断激活本身（客户端静默降级原则）
      let gatewayBind = null
      if (r.ok) {
        aiQuota.saveLicenseCode(p?.code ?? '')
        gatewayBind = await aiQuota.bindLicense(p?.code ?? '').catch(() => null)
      }
      return r.ok ? { ok: true, license: r.license, gatewayBind } : { ok: false, error: r.error }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle('license:quota', () => {
    try {
      return db ? quotaStatus(db, dataDir) : { level: 'free', plan: planFor('free'), usage: { sku: 0, stores: 1, users: 1 }, maxedOut: { sku: false, stores: false, users: false } }
    } catch {
      return { level: 'free', plan: planFor('free'), usage: { sku: 0, stores: 1, users: 1 }, maxedOut: { sku: false, stores: false, users: false } }
    }
  })
  // 新手引导通道
  ipcMain.handle('onboarding:status', () => {
    try { return commands.onboardingStatus(db) } catch { return { completed: false } }
  })
  ipcMain.handle('onboarding:finish', () => {
    try { return commands.finishOnboarding(db) } catch { return { ok: false } }
  })
  ipcMain.handle('onboarding:reset', () => {
    try {
      // 清空前强制备份
      import('./backup.js').then(({ backupNow }) => {
        try { backupNow(db, dbPath, backupDir) } catch { /* 备份失败不阻断清空 */ }
      })
      return commands.resetDemoData(db)
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
  // 清仓建议（决策层 MVP-1）：只读，走命令层单一来源 buildClearance
  ipcMain.handle('clearance:get', () => { try { return commands.buildClearance(db) } catch (e) { return { dataWindowOk: true, totalCandidate: 0, recoverableCost: 0, byPriority: { P0: 0, P1: 0, P2: 0 }, items: [], error: e.message } } })
  // 云备份通道：配对/快照/备份/恢复/吊销
  ipcMain.handle('cloud:status', () => getCloudState())
  ipcMain.handle('cloud:pair', (_e, p) => pairWithCloud(p?.pairCode ?? ''))
  ipcMain.handle('cloud:syncNow', () => syncSnapshot())
  ipcMain.handle('cloud:resolveConflict', () => resolveConflict())
  ipcMain.handle('cloud:backupNow', () => uploadBackup())
  ipcMain.handle('cloud:listBackups', () => listCloudBackups())
  ipcMain.handle('cloud:restore', async (_e, p) => {
    if (!p?.date) return { ok: false, error: '缺少备份日期' }
    const r = await restoreFromCloud(p.date)
    if (r?.ok) {
      // 恢复成功后关闭所有窗口并重启
      restoring = true
      for (const win of BrowserWindow.getAllWindows()) win.close()
      app.relaunch()
      app.exit(0)
    }
    return r
  })
  ipcMain.handle('cloud:regenViewLink', () => regenViewLink())
  // 多设备账户（v2）：注册/登录绑定本机
  ipcMain.handle('cloud:registerAccount', (_e, p) => cloudRegisterAccount(p?.username ?? '', p?.password ?? '', p?.note ?? ''))
  ipcMain.handle('cloud:loginAccount', (_e, p) => cloudLoginAccount(p?.username ?? '', p?.password ?? '', p?.deviceName ?? ''))
  ipcMain.handle('cloud:logout', () => cloudLogoutAccount())
  // 首登恢复：用户确认"我是新店/不用恢复"，解除上传挂起
  ipcMain.handle('cloud:dismissRestore', () => dismissRestoreHold())
  // 应用信息（设置页展示数据位置 + 最近备份时间：扫描备份目录最新文件）
  ipcMain.handle('app:info', () => {
    let lastBackupAt = null
    try {
      const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'))
      if (files.length > 0) {
        lastBackupAt = files
          .map((f) => fs.statSync(path.join(backupDir, f)).mtimeMs)
          .reduce((a, b) => Math.max(a, b), 0)
      }
    } catch {
      // 备份目录还没建（首次启动）就当没有备份
    }
    return { dataDir, dbPath, backupDir, version: app.getVersion(), lastBackupAt }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'AI 智能进销存系统',
    backgroundColor: '#e8eef6',
    // 窗口图标：electron/icon.png 随 electron/** 打进 asar，开发/打包路径一致
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只用 contextBridge/ipcRenderer，可安全开沙箱
      sandbox: true,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  // 窗口关闭后清空引用，second-instance / activate 里判空才不会拿到已销毁对象
  mainWindow.on('closed', () => { mainWindow = null })
  // 安全基线：渲染进程一律禁止弹新窗口；页面内导航只放行本地页面，其余全部拦截
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL
    const isLocal = url.startsWith('file://') || (devUrl && url.startsWith(devUrl))
    if (!isLocal) event.preventDefault()
  })
  // 渲染进程崩溃兜底：检测到崩溃/白屏 → 写日志 + 自动重载页面恢复，不让用户手动重启
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logCrash('render-process-gone', new Error(`reason=${details?.reason} exitCode=${details?.exitCode}`))
    // 自动重新加载页面（内存不足/进程被杀等场景恢复）
    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload()
        }
      } catch { /* 重载失败忽略，用户可手动重启 */ }
    }, 500)
  })
  // 页面加载失败（如磁盘满/资源损坏）也自动重载一次
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    logCrash('did-fail-load', new Error(`code=${code} desc=${desc}`))
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload()
      }
    } catch { /* 忽略 */ }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  // fi-img://photo/<文件名>：只放行 images 目录内文件（photo.js resolvePath 防路径穿越），
  // 文件经 file URL 转交给 net.fetch，省得自己拼 mime/流
  protocol.handle('fi-img', (request) => {
    try {
      const name = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''))
      const abs = photoStore.resolvePath(name)
      if (!abs || !fs.existsSync(abs)) return new Response('not found', { status: 404 })
      return net.fetch(pathToFileURL(abs).toString())
    } catch {
      return new Response('bad request', { status: 400 })
    }
  })
  // 麦克风权限（按住说话/唤醒词监听用）：只对本应用自己的页面放行 'media'，其余一律拒绝
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL()
    const devUrl = process.env.VITE_DEV_SERVER_URL
    const isLocal = url.startsWith('file://') || (devUrl && url.startsWith(devUrl))
    callback(permission === 'media' && !!isLocal)
  })
  // 崩溃上报：DSN 从环境变量取，未配置/初始化失败静默降级——绝不影响启动
  try {
    if (process.env.SENTRY_DSN) {
      Sentry.init({
        dsn: process.env.SENTRY_DSN,
        release: app.getVersion(),
        // 不上报用户数据（数据库路径/客户信息等），只上报堆栈
        beforeSend(event) {
          // 清除可能含敏感信息的 URL 参数
          if (event.request?.url) event.request.url = event.request.url.replace(/[?&].*/, '')
          return event
        },
      })
    }
  } catch { /* 挂了是免费版，不是打不开 */ }
    // 启动崩溃防护：数据库打不开（如老库迁移失败）时给出明确提示再退出，不无声崩溃
  try {
    db = openDatabase(dbPath)
  } catch (e) {
    const bakPath = dbPath + '.pre-migration.bak'
    const bakHint = fs.existsSync(bakPath)
      ? `\n迁移前的数据已留底：${bakPath}\n可将它改回 data.db 恢复旧数据。`
      : ''
    dialog.showErrorBox(
      '数据库打开失败',
      `程序无法启动，错误信息：${e.message}\n数据文件位置：${dbPath}${bakHint}`,
    )
    app.exit(1)
    return
  }
  ai.bindDb(db)
  voiceOrderService.initVoiceOrder(db) // P1-3：语音开单热词表/商品候选缓存
  // 1.0：orchestrator 统一 AI 出口（本地兜底优先）——初始化 db 引用
  orchestrator.initOrchestrator(db, dataDir)
  registerIpc()
  // 手机看店服务：db 就绪后随备份调度一起启动；失败只告警不阻断桌面端
  inventoryServer = createInventoryServer({ db, dataDir, webRoot: path.join(__dirname, '../dist'), ai, voice, doubao, voiceOrder: voiceOrderService })
  inventoryServer.start().catch((e) => console.error('[server] 启动失败:', e))
  const stopScheduler = scheduleDailyBackup(db, dbPath, backupDir, (e) =>
    reportBackupError('自动备份失败', e),
  getExtraDir)
  createWindow()
  // 自动更新：COS generic provider，try/catch 包裹——挂掉静默降级
  try { initAutoUpdater() } catch { /* 挂了是手动更新，不是打不开 */ }
  // 云备份：try/catch 包裹——挂了是本地单机版，不是打不开
  try {
    initCloud(db, dbPath, dataDir, backupDir, () => true)
  } catch { /* 云挂了不影响本地用 */ }
  // 模型已就绪则在启动时预加载识别器（约 1s），首次按住说话零等待；模型缺失静默跳过
  voice.preloadRecognizer()
  // TTS 模型已就绪同样预加载合成器，首次播报零等待；缺失静默跳过（播报回退系统语音）
  tts.preloadTts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('will-quit', () => {
    stopScheduler()
    stopCloudScheduler()
    inventoryServer?.stop()
    // 退出前 best-effort 传一次快照（500ms 超时，不阻塞退出）
    exitCloudSnapshot().catch(() => {})
    // 恢复备份重启：旧连接视图已脱节，跳过收尾备份/checkpoint
    if (restoring) return
    // 退出收尾：备份一次 + checkpoint 截断 WAL
    try {
      backupNow(db, dbPath, backupDir, getExtraDir())
    } catch (e) {
      // 退出阶段用户看不到任何界面，只写日志文件留痕，不弹框
      reportBackupError('退出备份失败', e)
    }
    finalCheckpoint(db)
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
