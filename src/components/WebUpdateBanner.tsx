import { useEffect, useState } from 'react'
import { RefreshCw, RotateCcw, X } from 'lucide-react'
import { backend } from '@/lib/api'

/**
 * B 通道（前端局部热更）的用户可见提示 —— 护栏④。
 *
 * 为什么必须有：热更包换的是**收银机正在用的页面**。静默替换一旦出问题，
 * 表现就是"账目/界面变了但没人知道为什么"，这种故障最难查。
 * 所以规则是：新前端**下好即提示**、**由人决定何时生效**（点一下重启进程，2 秒，不是重装）。
 * 界面回到旧版时也给一句解释（否则 owner 一定会问"我怎么又变回旧版了"）。
 */
type Status = {
  source?: string
  webVersion?: string
  builtinVersion?: string
  ready?: { webVersion: string } | null
  lastRollback?: { webVersion: string; at: string; reason: string } | null
  lastError?: string | null
  /** 口径层（C 通道）上一次被放弃的原因与时间 —— 独立字段，不会被页面自检的清错误清掉 */
  lastCodeError?: string | null
  lastCodeErrorAt?: string | null
}

export function WebUpdateBanner() {
  const [status, setStatus] = useState<Status | null>(null)
  const [percent, setPercent] = useState<number | null>(null)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!backend) return
    const api = (window as any).fi
    if (!api?.invoke) return
    // 只读状态，不在这里触发检查（自动检查由主进程每 6 小时做一次，避免每次启动都打网络）
    api.invoke('webupdate:status').then(setStatus).catch(() => { /* 老版本没有这个通道，忽略 */ })
    const unsubs = [
      api.onWebUpdateReady?.((d: { webVersion?: string }) =>
        setStatus((s) => ({ ...(s || {}), ready: { webVersion: String(d?.webVersion ?? '') } })),
      ),
      api.onWebUpdateProgress?.((p: { percent?: number }) => setPercent(p?.percent ?? null)),
    ]
    return () => unsubs.forEach((u: any) => u?.())
  }, [])

  async function applyNow() {
    if (!backend || busy) return
    setBusy(true)
    try {
      await backend.invoke('webupdate:restart')
    } catch {
      setBusy(false)
      setPercent(null)
    }
  }

  // 回退提示只在 24 小时内显示，且用户关掉就不再打扰
  const rollbackFresh = (() => {
    const at = status?.lastRollback?.at ? Date.parse(status.lastRollback.at) : NaN
    return Number.isFinite(at) && Date.now() - at < 24 * 3600 * 1000
  })()
  // 口径层（C 通道）被放弃也要说出来：否则"口径改了但没生效"这件事没人知道
  const codeErrorFresh = (() => {
    if (!status?.lastCodeError) return false
    const at = status?.lastCodeErrorAt ? Date.parse(status.lastCodeErrorAt) : NaN
    return !Number.isFinite(at) || Date.now() - at < 24 * 3600 * 1000
  })()

  if (hidden) return null

  const ready = status?.ready?.webVersion
  const showingRollback = !ready && percent === null && rollbackFresh
  if (!ready && percent === null && !rollbackFresh && !codeErrorFresh) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm">
      <div className="flex items-start gap-3 rounded-lg bg-slate-800 px-4 py-3 text-white shadow-lg">
        {ready ? <RefreshCw className="mt-0.5 size-4 shrink-0" /> : <RotateCcw className="mt-0.5 size-4 shrink-0" />}
        <div className="text-sm">
          {ready ? (
            <>
              <div className="font-medium">更新 v{ready} 已就绪</div>
              <div className="mt-0.5 text-white/70">点右边立即生效（重启约 2 秒，不影响数据）</div>
            </>
          ) : percent !== null ? (
            <>
              <div className="font-medium">正在准备更新… {percent}%</div>
              <div className="mt-0.5 text-white/70">下载并逐文件校验，完成后会提示你</div>
            </>
          ) : showingRollback ? (
            <>
              <div className="font-medium">界面更新未能正常显示，已自动退回上一版</div>
              <div className="mt-0.5 text-white/70">
                退回原因：{status?.lastRollback?.reason || '未通过启动自检'}
                {status?.builtinVersion ? `（当前 v${status.builtinVersion}）` : ''}
              </div>
            </>
          ) : (
            <>
              <div className="font-medium">口径层更新未启用，已用回内置版本</div>
              <div className="mt-0.5 text-white/70">
                {status?.lastCodeError || '热更的口径层没能加载起来'}
                <div>页面部分不受影响，账目口径按内置版本计算。</div>
              </div>
            </>
          )}
        </div>
        {ready && (
          <button
            onClick={applyNow}
            disabled={busy}
            className="shrink-0 rounded bg-white/20 px-3 py-1 text-sm font-medium hover:bg-white/30 cursor-pointer disabled:opacity-60"
          >
            {busy ? '重启中…' : '立即生效'}
          </button>
        )}
        <button
          onClick={() => setHidden(true)}
          className="shrink-0 hover:text-white/70 cursor-pointer"
          title="关闭"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
