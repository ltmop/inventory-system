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

  // 已登录云账号或已跳过：门不开
  if (cloudAuth === 'logged' || cloudAuth === 'guest') return null

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
          <h1 className="text-xl font-bold text-slate-800">通用进销存系统</h1>
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

        <div className="space-y-3">
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

          <div className="border-t border-slate-100 pt-3">
            <Button onClick={skip} variant="ghost" className="w-full text-slate-500">
              <Eye className="size-4" />
              跳过，先看看（只读演示模式）
            </Button>
            <p className="mt-2 text-center text-xs text-slate-400">
              跳过只能查看界面，入库/销售/盘点等操作需要登录账号
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
