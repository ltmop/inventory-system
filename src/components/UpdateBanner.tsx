import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { backend } from '@/lib/api'

/** 底部更新提示条：update:available 事件驱动，手动关闭前不消失 */
export function UpdateBanner() {
  const [visible, setVisible] = useState(false)
  const [version, setVersion] = useState('')
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    if (!backend) return
    const api = (window as any).fi
    if (!api?.onUpdateAvailable) return

    const unsub = api.onUpdateAvailable((info: { version: string }) => {
      setVersion(info.version)
      setVisible(true)
    })
    return unsub
  }, [])

  async function handleDownload() {
    if (!backend || downloading) return
    setDownloading(true)
    try {
      await backend.invoke('update:downloadAndInstall')
    } catch {
      // 下载失败，静默——用户下次启动还能再试
    } finally {
      setDownloading(false)
    }
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-lg bg-brand-700 px-5 py-3 text-white shadow-lg">
        <Download className="size-4" />
        <span className="text-sm">
          v{version} 已就绪
          {!downloading && '，建议更新'}
          {downloading && '，正在下载...'}
        </span>
        {!downloading && (
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
