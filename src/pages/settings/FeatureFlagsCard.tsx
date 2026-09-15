import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { backend } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

/**
 * 功能开关（Feature Flag，P3）—— 出事**秒关**，不用发版、不用热更。
 *
 * 四层优先级（写在界面上，是为了让"为什么这行改不动"一眼可见）：
 *   服务端下发「关」 > **本机这里** > 服务端下发「开」 > 出厂默认
 * 所以：本机可以否决服务端的"开"，但**否决不了服务端的"关"**（关永远是安全方向）。
 *
 * ⚠️ 开关是**每台机器各自生效**的。中心库服务器那份由它自己的 flags.json 与同一份下发决定 ——
 *    所以关掉一个功能时，如果店里是中心库模式，要确认服务端那边也关了（见设置页下方说明）。
 */
type FlagRow = {
  name: string
  desc: string
  def: boolean
  on: boolean
  source: string
  local: boolean | null
  remote: boolean | null
}
type Status = {
  flags?: FlagRow[]
  unknownLocal?: string[]
  unknownRemote?: string[]
  remoteFetchedAt?: string | null
  remoteAgeHours?: number | null
  remoteUrl?: string
  localFile?: string
}

const SOURCE_LABEL: Record<string, string> = {
  'remote-off': '服务端已关闭（本机改不动）',
  local: '本机设置',
  'remote-on': '服务端建议开启',
  default: '出厂默认',
  unknown: '未登记',
}

export function FeatureFlagsCard() {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => { void load() }, [])

  async function load() {
    if (!backend) return
    try {
      setStatus(await backend.invoke('flags:status'))
    } catch {
      setStatus(null) // 老版本没有这个通道：整张卡不显示
    }
  }

  async function setFlag(name: string, next: boolean | null) {
    if (!backend || busy) return
    setBusy(name)
    setMsg('')
    try {
      const r = await backend.invoke('flags:set', { name, on: next })
      if (r?.ok === false) setMsg(r.error || '设置失败')
      else setStatus(r)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  async function refresh() {
    if (!backend || busy) return
    setBusy('__refresh')
    setMsg('')
    try {
      const r = await backend.invoke('flags:refresh')
      if (r?.ok === false) setMsg(r.reason || '同步失败（不影响现有开关）')
      if (r?.status) setStatus(r.status)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const rows = status?.flags ?? []
  if (!status || rows.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          功能开关
          <span className="text-xs font-normal text-muted-foreground">出事可以秒关，不用等发版</span>
        </CardTitle>
        <CardDescription>
          关掉是**立刻生效**的（不用重启、断网也生效）。每台电脑各自生效 ——
          中心库模式下，服务端那台也要一起关才彻底。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((f) => {
          const lockedByRemote = f.source === 'remote-off'
          return (
            <div key={f.name} className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{f.desc}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {f.on ? '当前：开启' : '当前：已关闭'} · 来源：{SOURCE_LABEL[f.source] ?? f.source}
                  {f.local !== null ? ` · 本机覆盖：${f.local ? '开' : '关'}` : ''}
                  {` · 出厂默认：${f.def ? '开' : '关'}`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  disabled={!!busy || lockedByRemote}
                  onClick={() => setFlag(f.name, !f.on)}
                  className="rounded border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50"
                  title={lockedByRemote ? '服务端已关闭，本机无法打开' : ''}
                >
                  {f.on ? '关闭' : '打开'}
                </button>
                {f.local !== null && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => setFlag(f.name, null)}
                    className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
                    title="删掉本机设置，跟随上级（服务端 / 出厂默认）"
                  >
                    恢复默认
                  </button>
                )}
              </div>
            </div>
          )
        })}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
          <div className="min-w-0">
            <div className="truncate">本机设置文件：{status.localFile || '（未知）'}</div>
            <div className="truncate">
              服务端下发：
              {status.remoteFetchedAt
                ? `${status.remoteAgeHours ?? 0} 小时前同步过`
                : '还没同步过（只用本机设置与出厂默认）'}
            </div>
            {(status.unknownLocal?.length ?? 0) > 0 && (
              <div className="mt-1 text-amber-600">
                警告：本机文件里有未登记的开关名 {status.unknownLocal!.join('、')} —— 名字打错就会「以为关了其实没关」
              </div>
            )}
          </div>
          <button
            type="button"
            disabled={!!busy}
            onClick={refresh}
            className="flex shrink-0 items-center gap-1 rounded border px-2 py-1 hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`size-3 ${busy === '__refresh' ? 'animate-spin' : ''}`} />
            立即同步服务端
          </button>
        </div>

        {msg && <div className="text-xs text-red-600">{msg}</div>}
      </CardContent>
    </Card>
  )
}
