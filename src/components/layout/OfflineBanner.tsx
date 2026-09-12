// OfflineBanner.tsx —— 顶栏「离线 / 待上传」胶囊（A3 离线层的 UI 出口）
//
// 【为什么需要它】
// A3 离线层落地后，断网开单会把单据排进本机队列、联网自动幂等重放 —— **数据是安全的**。
// 但界面上一点提示都没有，店主会以为这单没记上，转头重新开一遍。
// 这个胶囊把队列状态暴露出来：网络已断开 / 离线 N 笔待上传 / N 笔被拒绝。
//
// 【数据从哪来】
// src/lib/api.ts 导出的 offline（= src/lib/offlineTransport.js 的控制面）。
// 入队成功（queueWrite）、重放成功（flush）、被中心库拒绝（标 failed）都会调 notify()，
// 订阅者立刻收到新状态 —— 所以胶囊是「即时」的，不是轮询。
//
// 【为什么点击就是重传】
// 断网恢复虽然有 online 事件自动重放，但「店主等不及」和「上次重放失败」是常态，
// 给一个手动按钮比让他干等更符合门店实际。
import { useEffect, useState } from 'react'
import { AlertTriangle, CloudUpload } from 'lucide-react'
import { offline } from '@/lib/api'
import { useOnline } from '@/lib/useOnline'

export function OfflineChip() {
  const online = useOnline()
  const [q, setQ] = useState(() => offline.state())
  const [busy, setBusy] = useState(false)

  useEffect(() => offline.subscribe(setQ), [])

  const pending = q.pending
  const failed = q.failed
  // 一切正常就完全不出现 —— 不占位置、不制造噪音
  if (online && pending === 0 && failed === 0) return null

  const isRed = failed > 0
  const label = isRed
    ? failed + ' 笔被拒绝' + (pending > 0 ? ' · ' + pending + ' 笔待上传' : '')
    : pending > 0
      ? (online ? '离线 ' + pending + ' 笔待上传' : '网络已断开 · ' + pending + ' 笔在本地排队')
      : '网络已断开'

  const title = isRed
    ? failed + ' 笔被中心库拒绝（不会自动重试，需人工处理），另有 ' + pending + ' 笔待上传。点击重传。'
    : online
      ? pending + ' 笔离线单据等待上传。点击立即重传。'
      : '网络已断开。已开的单子都存在本机，恢复网络后会自动上传（当前 ' + pending + ' 笔）。'

  async function retry() {
    if (busy) return
    setBusy(true)
    try { await offline.flush() } catch { /* 队列自身不抛；保险，别让 UI 崩 */ }
    finally { setBusy(false) }
  }

  const tone = isRed
    ? 'text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30'
    : 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30'

  return (
    <button
      onClick={retry}
      disabled={busy || !online}
      title={title}
      aria-label={label}
      className={'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium cursor-pointer disabled:cursor-default ' + tone}
    >
      {isRed ? <AlertTriangle className="size-4" /> : <CloudUpload className="size-4" />}
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{isRed ? failed : pending || '离线'}</span>
    </button>
  )
}
