import { useCallback, useEffect, useMemo, useState } from 'react'
import { Terminal, Play, X, RefreshCw, Search } from 'lucide-react'
import { backend } from '@/lib/api'

/**
 * 命令台（Ctrl+Shift+C 开关）
 *
 * 为什么要它：命令层有近 200 条命令，但界面只暴露了常用的一部分 
 *   老板排障、批量操作、外部 Agent 驱动，都需要一个"直接下命令"的入口。
 * 它走的是 commands:* IPC（自省 + 通用调用），清单来自 electron/commandRegistry.json，
 *   与 HTTP 的 POST /api/command、以及 docs/命令接口-接口文档.md 是同一份真相源。
 */

type Cmd = { name: string; group: string; desc?: string; impl?: string | null; ipc?: boolean; http?: boolean }

export function CommandConsole() {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState<Cmd[]>([])
  const [groups, setGroups] = useState<Record<string, number>>({})
  const [q, setQ] = useState('')
  const [name, setName] = useState('')
  const [params, setParams] = useState('{}')
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Ctrl+Shift+C 开关
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const load = useCallback(async () => {
    if (!backend) { setErr('当前不是桌面环境（浏览器调试模式），命令台不可用'); return }
    try {
      const r = await backend.invoke('commands:list', {})
      setAll(r?.commands ?? [])
      setGroups(r?.groups ?? {})
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { if (open && all.length === 0) load() }, [open, all.length, load])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return all.slice(0, 80)
    return all
      .filter((c) => c.name.toLowerCase().includes(kw) || String(c.desc || '').toLowerCase().includes(kw))
      .slice(0, 80)
  }, [all, q])

  const run = useCallback(async () => {
    if (!backend) return
    setBusy(true); setOut(''); setErr(null)
    try {
      let p: unknown = {}
      try { p = params.trim() ? JSON.parse(params) : {} } catch { throw new Error('参数不是合法 JSON') }
      const r = await backend.invoke('commands:invoke', { name: name.trim(), params: p })
      setOut(JSON.stringify(r, null, 2))
      if (r && r.ok === false) setErr(r.error || '执行失败')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [name, params])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="命令台（Ctrl+Shift+C）"
        className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full bg-slate-900/85 px-3 py-2 text-xs font-medium text-white shadow-lg hover:bg-slate-900 cursor-pointer"
      >
        <Terminal className="size-3.5" /> 命令台
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6" onClick={() => setOpen(false)}>
      <div
        className="flex h-[78vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
          <Terminal className="size-4 text-brand-600" />
          <span className="text-sm font-semibold">命令台</span>
          <span className="text-xs text-slate-400">{all.length} 条命令  {Object.keys(groups).length} 个前缀</span>
          <div className="flex-1" />
          <button onClick={load} title="重新载入命令清单" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer">
            <RefreshCw className="size-3.5" />
          </button>
          <button onClick={() => setOpen(false)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：命令清单 */}
          <div className="flex w-80 shrink-0 flex-col border-r border-slate-100">
            <div className="flex items-center gap-1.5 border-b border-slate-100 px-3 py-2">
              <Search className="size-3.5 text-slate-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜命令名或说明"
                className="w-full bg-transparent text-xs outline-none placeholder:text-slate-400"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {filtered.map((c) => (
                <button
                  key={c.name}
                  onClick={() => setName(c.name)}
                  className={
                    'w-full border-b border-slate-50 px-3 py-1.5 text-left hover:bg-slate-50 cursor-pointer ' +
                    (name === c.name ? 'bg-brand-50' : '')
                  }
                >
                  <div className="truncate font-mono text-[11px] text-slate-700">{c.name}</div>
                  {c.desc ? <div className="truncate text-[10px] text-slate-400">{c.desc}</div> : null}
                </button>
              ))}
              {filtered.length === 0 && <div className="px-3 py-3 text-xs text-slate-400">没有匹配的命令</div>}
            </div>
          </div>

          {/* 右：执行区 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="space-y-2 border-b border-slate-100 p-3">
              <div className="flex items-center gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="命令名，例如 data:loadAll / product:create"
                  className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1.5 font-mono text-xs outline-none focus:border-brand-400"
                />
                <button
                  onClick={run}
                  disabled={busy || !name.trim()}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50 cursor-pointer"
                >
                  <Play className="size-3" /> {busy ? '执行中' : '执行'}
                </button>
              </div>
              <textarea
                value={params}
                onChange={(e) => setParams(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder='参数 JSON，例如 {"limit":20}'
                className="w-full resize-y rounded-md border border-slate-200 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-brand-400"
              />
            </div>
            {err && (
              <div className="border-b border-red-100 bg-red-50 px-3 py-1.5 text-xs text-red-600">{err}</div>
            )}
            <pre className="min-h-0 flex-1 overflow-auto bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-300">
{out || '// 执行结果会显示在这里'}
            </pre>
            <div className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400">
              三条通道同源：桌面 IPC（此处） HTTP <code>POST /api/command</code>  文档 <code>docs/命令接口-接口文档.md</code>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}