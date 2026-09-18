// API 接口（2026-09-16 owner 要求：把右下角悬浮的「命令台」搬进左侧功能栏，做成正式页面）
//
// 为什么要有它：命令层有近 200 条命令，界面只暴露了常用的一部分 ——
//   老板排障、批量操作、外部 Agent 驱动，都需要一个"直接下命令"的入口。
//
// 三条通道同源（清单都来自 electron/commandRegistry.json，不存在第二套口径）：
//   ① 本页          → 桌面 IPC：commands:list / commands:invoke
//   ② HTTP          → POST /api/command、POST /api/invoke（中心库模式下客户端走这条）
//   ③ 文档/给 Agent → docs/命令接口-接口文档.md、docs/进销存系统Agent接入指南.md
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Terminal, Play, RefreshCw, Search, Copy, Check, BookOpen, KeyRound } from 'lucide-react'
import { backend } from '@/lib/api'
import { PageHeading } from '@/components/layout/FeatureGrid'

type Cmd = { name: string; group: string; desc?: string; impl?: string | null; ipc?: boolean; http?: boolean }

/** HTTP 接入信息：与 GET /api/agent 自描述、docs/命令接口-接口文档.md 同一份真相源 */
const HTTP_ROWS = [
  { m: 'GET', p: '/api/agent', d: '自描述入口：能力清单、鉴权方式、读写分组' },
  { m: 'GET', p: '/api/commands', d: '命令自省，支持 ?name= / ?group= / ?q=' },
  { m: 'POST', p: '/api/invoke', d: '通用调用：{ channel, payload }' },
  { m: 'POST', p: '/api/command', d: '按名调用：{ name, params }' },
]

export default function ApiPage() {
  const [all, setAll] = useState<Cmd[]>([])
  const [groups, setGroups] = useState<Record<string, number>>({})
  const [q, setQ] = useState('')
  const [name, setName] = useState('')
  const [params, setParams] = useState('{}')
  const [out, setOut] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState('')

  const load = useCallback(async () => {
    if (!backend) { setErr('当前不是桌面环境（浏览器调试模式），命令接口不可用'); return }
    try {
      const r = await backend.invoke('commands:list', {})
      setAll(r?.commands ?? [])
      setGroups(r?.groups ?? {})
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return all.slice(0, 200)
    return all
      .filter((c) => c.name.toLowerCase().includes(kw) || String(c.desc || '').toLowerCase().includes(kw))
      .slice(0, 200)
  }, [all, q])

  const copy = useCallback(async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      window.setTimeout(() => setCopied(''), 1500)
    } catch { /* 剪贴板不可用就算了，不影响用 */ }
  }, [])

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

  return (
    <div className="space-y-4">
      <PageHeading
        title="API 接口"
        desc="近 200 条业务命令的统一入口，供排障、批量操作与外部 Agent 接入"
        icon={Terminal}
        action={
          <button
            onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
          >
            <RefreshCw className="size-4" /> 重新载入
          </button>
        }
      />

      {/* 接入信息：给 Agent / 外部程序看的四条 HTTP 端点 */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <BookOpen className="size-4 text-brand-600" />
          <span className="text-sm font-semibold text-slate-900">HTTP 接入</span>
          <span className="text-xs text-slate-400">与桌面 IPC 同源，命令清单来自 electron/commandRegistry.json</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-slate-100">
          {HTTP_ROWS.map((r) => (
            <div key={r.p} className="flex items-center gap-3 border-b border-slate-50 px-3 py-2 last:border-b-0">
              <span className="w-14 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold text-slate-600">
                {r.m}
              </span>
              <code className="shrink-0 font-mono text-xs text-slate-800">{r.p}</code>
              <span className="truncate text-xs text-slate-500">{r.d}</span>
              <div className="flex-1" />
              <button
                onClick={() => void copy(`${r.m} ${r.p}`, r.p)}
                title="复制路径"
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
              >
                {copied === r.p ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
              </button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <KeyRound className="size-3.5 text-amber-500" />
          <span>
            鉴权：请求头 <code className="rounded bg-slate-100 px-1 py-0.5 font-mono">x-token</code>
            （桌面机见「设置 → 手机看店」，中心库模式用中心库那台的令牌）；缺令牌一律 401。
          </span>
          <button
            onClick={() => void copy('curl -s -H "x-token: <令牌>" http://127.0.0.1:<端口>/api/commands', 'curl')}
            className="flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
          >
            {copied === 'curl' ? <Check className="size-3" /> : <Copy className="size-3" />} 复制 curl 示例
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          完整文档：<code className="mx-0.5 rounded bg-slate-100 px-1 py-0.5 font-mono">docs/命令接口-接口文档.md</code>
          （生成物，随代码自动同步）与
          <code className="mx-0.5 rounded bg-slate-100 px-1 py-0.5 font-mono">docs/进销存系统Agent接入指南.md</code>
        </p>
      </section>

      {/* 命令浏览器 + 执行区 */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
          <Terminal className="size-4 text-brand-600" />
          <span className="text-sm font-semibold text-slate-900">命令台</span>
          <span className="text-xs text-slate-400">
            {all.length} 条命令 · {Object.keys(groups).length} 个前缀
          </span>
        </div>

        <div className="flex min-h-0" style={{ height: 'calc(100vh - 430px)', minHeight: '380px' }}>
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
                  onClick={() => void run()}
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
          </div>
        </div>
      </section>
    </div>
  )
}
