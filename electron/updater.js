// 自动更新模块：electron-updater → COS generic provider
// 铁律：try/catch 全部包裹，任何环节挂掉静默降级——挂了是手动更新，不是打不开
// electron-updater 是 CJS 包（main=out/main.js），ESM 命名导入拿不到 autoUpdater，
// 必须走 default 导入再解构（打包环境已实测命名导入直接启动崩溃）
import electronUpdater from 'electron-updater'
import { app, dialog, BrowserWindow } from 'electron'

const { autoUpdater } = electronUpdater

/** 版本号比较（1.0.10 vs 1.0.9 这种不能被字符串比较糊弄过去）：a>b 返回正数 */
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

/** 初始化自动更新（COS generic provider，URL 在 package.json build.publish 配置） */
export function initAutoUpdater() {
  try {
    // 开发环境不检查更新（Vite dev server 没有安装包版本概念）
    if (process.env.VITE_DEV_SERVER_URL) return

    autoUpdater.autoDownload = false // 提醒用户后手动下载
    autoUpdater.autoInstallOnAppQuit = true // 退出时安装

    autoUpdater.on('update-available', (info) => {
      // 通知渲染进程弹出 UpdateBanner
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('update:available', {
          version: info.version,
          releaseDate: info.releaseDate,
        })
      }
    })

    autoUpdater.on('update-not-available', () => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('update:not-available', { checkedAt: new Date().toISOString() })
      }
    })

    autoUpdater.on('error', (err) => {
      console.error('[updater] 自动更新出错:', err.message)
    })

    autoUpdater.on('download-progress', (progress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('update:progress', { percent: Math.round(progress.percent) })
      }
    })

    autoUpdater.on('update-downloaded', () => {
      // 下载完成，弹系统对话框确认
      dialog
        .showMessageBox({
          type: 'info',
          title: '新版本已就绪',
          message: '新版本已下载完成，是否立即重启安装？',
          buttons: ['重启安装', '稍后再说'],
          defaultId: 0,
        })
        .then(({ response }) => {
          if (response === 0) {
            autoUpdater.quitAndInstall()
          }
        })
    })

    // 启动后 10 秒静默检查一次，避免阻塞启动流程
    setTimeout(() => {
      try {
        autoUpdater.checkForUpdates().catch(() => {})
      } catch { /* 网络不通/服务器挂了，静默 */ }
    }, 10_000)
  } catch {
    // 初始化失败，静默降级——软件照常用，只是没自动更新
  }
}

/**
 * 手动检查更新（设置页按钮触发）。
 *
 * 返回结构明确区分三种结果，**绝不把"检查失败"伪装成"已是最新"**：
 *   { ok:true,  hasUpdate:false, currentVersion, latestVersion, checkedAt }  已经是最新
 *   { ok:true,  hasUpdate:true,  currentVersion, latestVersion, checkedAt }  有新版可更新
 *   { ok:false, error,           currentVersion, checkedAt }                 检查失败（带原因，供界面显示）
 *
 * 两个曾经的坑：
 *  ① 以前 catch 里只返回 { checkedAt }（没有 version）→ 界面把"没有 version"当成"没有新版"→
 *     **网络不通/配置缺失时反而显示"已是最新"**，比不显示更糟：它让人以为已经查过了。
 *  ② 以前用渲染层的 APP_VERSION 比对。那是**构建时写死**的版本号，与当前真正在跑的包可能不一致；
 *     改用主进程的 app.getVersion()（当前安装版本的真值）。
 */
export async function checkForUpdates() {
  const checkedAt = new Date().toISOString()
  let currentVersion = ''
  try { currentVersion = app.getVersion() } catch { currentVersion = '' }
  try {
    const result = await autoUpdater.checkForUpdates()
    const latestVersion = result?.updateInfo?.version ?? null
    if (!latestVersion) {
      return { ok: false, error: '更新源没有返回版本号（latest.yml 可能有问题）', currentVersion, checkedAt }
    }
    return {
      ok: true,
      hasUpdate: cmpVersion(latestVersion, currentVersion) > 0,
      currentVersion,
      latestVersion,
      checkedAt,
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e), currentVersion, checkedAt }
  }
}

/** 下载并安装更新 */
export async function downloadAndInstall() {
  try {
    await autoUpdater.downloadUpdate()
  } catch (e) {
    console.error('[updater] 下载失败:', e.message)
    throw e
  }
}
