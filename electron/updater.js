// 自动更新模块：electron-updater → COS generic provider
// 铁律：try/catch 全部包裹，任何环节挂掉静默降级——挂了是手动更新，不是打不开
// electron-updater 是 CJS 包（main=out/main.js），ESM 命名导入拿不到 autoUpdater，
// 必须走 default 导入再解构（打包环境已实测命名导入直接启动崩溃）
import electronUpdater from 'electron-updater'
import { dialog, BrowserWindow } from 'electron'

const { autoUpdater } = electronUpdater

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

/** 手动检查更新（设置页按钮触发） */
export async function checkForUpdates() {
  try {
    const result = await autoUpdater.checkForUpdates()
    return {
      version: result?.updateInfo?.version,
      checkedAt: new Date().toISOString(),
    }
  } catch {
    return { checkedAt: new Date().toISOString() }
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
