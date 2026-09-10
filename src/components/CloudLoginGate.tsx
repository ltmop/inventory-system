// 云账号登录门：进入系统先登录/注册云账号（多设备同步），也可跳过进入「只读演示模式」
import { useState } from 'react'
import { KeyRound, LogIn, UserPlus, Eye } from 'lucide-react'
import { backend, setGuestMode, setCentralConfig, getCentralConfig } from '@/lib/api'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function CloudLoginGate() {
  const cloudAuth = useAppStore((s) => s.cloudAuth)
  const setCloudAuth = useAppStore((s) => s.setCloudAuth)
  const setCloud = useAppStore((s) => s.setCloud)

  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showForgot, setShowForgot] = useState(false)
  // 首登恢复：新电脑登录老账号，云端有备份 → 引导恢复（上传已被主进程挂起）
  const [pendingRestore, setPendingRestore] = useState<{ date: string; size: number } | null>(null)
  // P0 数据同步：首启主推「连接中心库」(与手机/网页同账)
  const [centralMode, setCentralMode] = useState<'idle' | 'fill'>('idle')
  const [cenUrl, setCenUrl] = useState(getCentralConfig().url || 'https://app.junchengzn.com')
  const [cenToken, setCenToken] = useState('')

  // 本地优先：默认不弹门；只有用户主动点「登录」（或登出后）才会打开（cloudAuth === 'none'）
  if (cloudAuth !== 'none') return null

  const submit = async () => {
    if (busy) return
    if (!username.trim() || password.length < 6) {
      setError('账号和密码都要填（密码至少 6 位）')
      return
    }
    setBusy(true)
    setError('')
    try {
      const deviceName = `${navigator.platform} ${new Date().toLocaleDateString('zh-CN')}`
      const r = mode === 'register'
        ? await backend!.invoke('cloud:registerAccount', { username: username.trim(), password, deviceName })
        : await backend!.invoke('cloud:loginAccount', { username: username.trim(), password, deviceName })
      if (r?.ok) {
        setGuestMode(false)
        setCloud({
          paired: true, username: r.username ?? null, viewUrl: r.viewUrl, error: null,
          needsRestore: r.needsRestore === true,
          pendingBackup: r.latestBackup ?? null,
        })
        if (r.needsRestore && r.latestBackup) {
          // 不直接进门：先让用户选"恢复云端数据"还是"我是新店"
          setPendingRestore(r.latestBackup)
          return
        }
        setCloudAuth('logged')
      } else {
        setError(r?.error || (mode === 'register' ? '注册失败' : '登录失败'))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const skip = () => {
    // 本地模式：不登录也能全功能使用（数据在本机）；随时可在「账号」页登录同步
    setGuestMode(true)
    setCloudAuth('guest')
  }

  // P0 数据同步：连接中心库（与手机/网页同一本账），保存后重载让 api.ts 走中心库模式
  const connectCentral = async () => {
    if (busy) return
    if (!cenUrl.trim() || !cenToken.trim()) { setError('填中心库地址和访问 token'); return }
    setBusy(true); setError('')
    try {
      setCentralConfig(cenUrl.trim(), cenToken.trim())
      setCloudAuth('logged')
      setCloud({ paired: true, username: null, viewUrl: null, error: null, needsRestore: false, pendingBackup: null })
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0d1b30]">
      <div className="w-[420px] rounded-2xl bg-white p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-brand-600 text-white">
            <KeyRound className="size-7" />
          </div>
          <h1 className="text-xl font-bold text-slate-800">AI 智能进销存系统</h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'login' ? '登录云账号，多台电脑数据自动同步' : '注册一个账号，所有电脑登录后数据互通'}
          </p>
        </div>

        {/* P0 数据同步：优先连接中心库（与手机/网页同一本账） */}
        {centralMode === 'idle' ? (
          <div className="mb-4 rounded-xl bg-brand-50 p-4">
            <div className="mb-1 text-sm font-semibold text-slate-800">连接中心库（推荐 · 与手机/网页同一本账）</div>
            <p className="mb-3 text-xs leading-relaxed text-slate-500">填店里中心库地址 + 访问 token，桌面就读写 app.junchengzn.com 中心库——手机/网页/桌面对同一份实时账，数据不再各存各的。</p>
            <Button onClick={() => { setCentralMode('fill'); setError('') }} className="w-full bg-brand-600 hover:bg-brand-700">连接中心库</Button>
            <Button onClick={skip} variant="outline" className="mt-2 w-full">先用本机数据（本地模式）</Button>
          </div>
        ) : (
          <div className="mb-4 space-y-3 rounded-xl bg-slate-50 p-4">
            <div className="text-sm font-semibold text-slate-800">连接中心库（与手机/网页同账）</div>
            <Input value={cenUrl} onChange={(e) => setCenUrl(e.target.value)} placeholder="中心库地址" />
            <Input value={cenToken} onChange={(e) => setCenToken(e.target.value)} placeholder="访问 token（店主提供）" />
            <Button onClick={connectCentral} disabled={busy} className="w-full bg-brand-600 hover:bg-brand-700">{busy ? '连接中…' : '保存并连接中心库'}</Button>
            <button onClick={() => { setCentralMode('idle'); setError('') }} className="cursor-pointer text-xs text-brand-600 underline">返回</button>
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          </div>
        )}
        <div className="mb-2 text-center text-xs text-slate-400">或使用旧版云账号多机快照同步：</div>
        {/* 登录 / 注册切换 */}
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
          <button
            onClick={() => { setMode('login'); setError('') }}
            className={`rounded-md py-2 text-sm font-bold transition-colors cursor-pointer ${mode === 'login' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500'}`}
          >
            <span className="inline-flex items-center gap-1"><LogIn className="size-3.5" />登录</span>
          </button>
          <button
            onClick={() => { setMode('register'); setError('') }}
            className={`rounded-md py-2 text-sm font-bold transition-colors cursor-pointer ${mode === 'register' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500'}`}
          >
            <span className="inline-flex items-center gap-1"><UserPlus className="size-3.5" />注册</span>
          </button>
        </div>

        {pendingRestore ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-brand-50 px-4 py-3 text-[13px] leading-relaxed text-slate-700">
              <div className="mb-1 text-sm font-semibold text-slate-800">这台电脑是新装的？</div>
              检测到云端有这个账号的数据备份（<b>{pendingRestore.date}</b>，{(pendingRestore.size / 1024).toFixed(0)} KB）。
              为避免空数据覆盖云端，<b>自动上传已暂停</b>。
            </div>
            <Button
              onClick={async () => {
                if (!backend || busy) return
                setBusy(true)
                try {
                  // 恢复成功后主进程会自动重启软件
                  const r = await backend.invoke('cloud:restore', { date: pendingRestore.date })
                  if (!r?.ok) { setError(r?.error || '恢复失败'); setBusy(false) }
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                  setBusy(false)
                }
              }}
              disabled={busy}
              className="w-full bg-brand-600 hover:bg-brand-700"
            >
              {busy ? '正在恢复云端数据...' : `恢复 ${pendingRestore.date} 的数据到本机（推荐）`}
            </Button>
            <Button
              onClick={async () => {
                if (!backend) return
                await backend.invoke('cloud:dismissRestore').catch(() => {})
                setCloud({ needsRestore: false, pendingBackup: null })
                setCloudAuth('logged')
              }}
              variant="outline"
              className="w-full"
            >
              我是新店，从零开始（不用恢复）
            </Button>
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          </div>
        ) : showForgot ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-lake-50 px-4 py-3 text-[13px] leading-relaxed text-slate-600">
              <div className="mb-1 text-sm font-semibold text-slate-800">忘记密码？数据不会丢</div>
              您的数据保存在<b>这台电脑</b>上（本地优先），<b>不依赖云账号密码</b>——忘记密码也不影响本机数据，随时可用。
              <div className="mt-1.5">云账号只用于「多台电脑同步 + 云端备份」；忘密码只影响同步与云备份的找回，本机库存照常。</div>
            </div>
            <Button onClick={() => { setMode('register'); setShowForgot(false); setError('') }} className="w-full bg-brand-600 hover:bg-brand-700">
              <UserPlus className="size-4" /> 注册新账号，重新开启同步
            </Button>
            <p className="text-center text-xs text-slate-400">本机会把本地数据上传到新账号；数据在本机，可随时重新同步。</p>
            <Button onClick={skip} variant="outline" className="w-full">
              <Eye className="size-4" /> 直接用本机数据（不需要账号）
            </Button>
          </div>
        ) : (
          <>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="账号（店名，多台电脑用同一个）"
              autoFocus
            />
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="密码（至少 6 位）"
            />
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <Button onClick={submit} disabled={busy || !backend} className="w-full bg-brand-600 hover:bg-brand-700">
              {mode === 'login' ? '登录（绑定本机）' : '注册并登录（绑定本机）'}
            </Button>
            {mode === 'register' && (
              <p className="text-center text-xs text-slate-400">注册即绑定本机；多台电脑登录同一账号自动同步。</p>
            )}
            <div className="text-right">
              <button onClick={() => setShowForgot(true)} className="text-xs text-brand-600 underline hover:text-brand-800 cursor-pointer">
                忘记密码？
              </button>
            </div>
            <div className="space-y-3 border-t pt-3">
              <Button onClick={skip} variant="outline" className="w-full">
                <Eye className="size-4" />
                先不登录，直接用（数据在这台电脑上）
              </Button>
              <p className="text-center text-xs text-slate-400">
                没账号也能正常开单、入库、盘点；登录账号后多台电脑自动同步、云端备份，随时可在「账号」页登录
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
