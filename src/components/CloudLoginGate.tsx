// 云账号登录门：进入系统先登录/注册云账号（多设备同步），也可跳过进入「只读演示模式」
import { useState } from 'react'
import { KeyRound, LogIn, UserPlus, Eye } from 'lucide-react'
import { backend, setGuestMode } from '@/lib/api'
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
        setCloud({ paired: true, username: r.username ?? null, viewUrl: r.viewUrl, error: null })
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0d1b30]">
      <div className="w-[420px] rounded-2xl bg-white p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-blue-600 text-white">
            <KeyRound className="size-7" />
          </div>
          <h1 className="text-xl font-bold text-slate-800">AI 智能进销存系统</h1>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'login' ? '登录云账号，多台电脑数据自动同步' : '注册一个账号，所有电脑登录后数据互通'}
          </p>
        </div>

        {/* 登录 / 注册切换 */}
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
          <button
            onClick={() => { setMode('login'); setError('') }}
            className={`rounded-md py-2 text-sm font-bold transition-colors cursor-pointer ${mode === 'login' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}
          >
            <span className="inline-flex items-center gap-1"><LogIn className="size-3.5" />登录</span>
          </button>
          <button
            onClick={() => { setMode('register'); setError('') }}
            className={`rounded-md py-2 text-sm font-bold transition-colors cursor-pointer ${mode === 'register' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}
          >
            <span className="inline-flex items-center gap-1"><UserPlus className="size-3.5" />注册</span>
          </button>
        </div>

        {showForgot ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-sky-50 px-4 py-3 text-[13px] leading-relaxed text-slate-600">
              <div className="mb-1 text-sm font-semibold text-slate-800">忘记密码？数据不会丢</div>
              您的数据保存在<b>这台电脑</b>上（本地优先），<b>不依赖云账号密码</b>——忘记密码也不影响本机数据，随时可用。
              <div className="mt-1.5">云账号只用于「多台电脑同步 + 云端备份」；忘密码只影响同步与云备份的找回，本机库存照常。</div>
            </div>
            <Button onClick={() => { setMode('register'); setShowForgot(false); setError('') }} className="w-full bg-blue-600 hover:bg-blue-700">
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
            <Button onClick={submit} disabled={busy || !backend} className="w-full bg-blue-600 hover:bg-blue-700">
              {mode === 'login' ? '登录（绑定本机）' : '注册并登录（绑定本机）'}
            </Button>
            {mode === 'register' && (
              <p className="text-center text-xs text-slate-400">注册即绑定本机；多台电脑登录同一账号自动同步。</p>
            )}
            <div className="text-right">
              <button onClick={() => setShowForgot(true)} className="text-xs text-blue-600 underline hover:text-blue-800 cursor-pointer">
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
