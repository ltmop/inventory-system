import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { backend } from '@/lib/api'

/** 底部更新提示条：update:available 事件驱动，手动关闭前不消失 */
export function UpdateBanner() {
  const [visible, setVisible] = useState(false)
  const [version, setVersion] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [percent, setPercent] = useState(0)
  const [done, setDone] = useState(false)
  // 2026-09-14：下载/安装失败要把原因显示出来。以前一律静默吞掉，
  // 于是"通道不通"这类故障在界面上表现为「点了没反应」——最难查的一种。
  const [error, setError] = useState('')

  useEffect(() => {
    if (!backend) return
    const api = (window as any).fi
    if (!api?.onUpdateAvailable) return

    const unsubs = [
      api.onUpdateAvailable((info: { version: string }) => {
        setVersion(info.version)
        setError('')
        setVisible(true)
      }),
      // 下载进度（update:progress），显示百分比
      api.onUpdateProgress?.((p: { percent?: number }) => {
        setPercent(p?.percent ?? 0)
      }),
    ]
    return () => unsubs.forEach((u) => u?.())
  }, [])

  async function handleDownload() {
    if (!backend || downloading) return
    setDownloading(true)
    setPercent(0)
    try {
      await backend.invoke('update:downloadAndInstall')
      // 下载完成：主进程 update-downloaded 会弹「重启安装」对话框，
      // banner 同步改为「已就绪」
      setDone(true)
    } catch (e) {
      // 2026-09-14：不再静默。以前这里无声吞掉，于是中心库模式下
      // update:downloadAndInstall 走 HTTP 得到 unknown channel 时，
      // 用户看到的是「点了没反应」——最难查的一类故障。现在把原因显示出来，并允许重试。
      setDownloading(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-lg bg-brand-700 px-5 py-3 text-white shadow-lg">
        <Download className="size-4" />
        <span className="text-sm">
          {error ? (
            <>更新失败：{error}</>
          ) : done ? (
            <>v{version} 已就绪，重启后安装</>
          ) : downloading ? (
            <>正在下载 v{version}… {percent > 0 ? percent + '%' : ''}</>
          ) : (
            <>v{version} 已就绪，建议更新</>
          )}
        </span>
        {!downloading && !done && (
          <button
            onClick={handleDownload}
            className="rounded bg-white/20 px-3 py-1 text-sm font-medium hover:bg-white/30 cursor-pointer"
          >
            下载更新
          </button>
        )}
        <button
          onClick={() => setVisible(false)}
          className="hover:text-white/70 cursor-pointer"
          title="关闭"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
