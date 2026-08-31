// 员工登录门（v0.1）：老板在设置页开启员工登录后，启动必须选人登录才进得去。
// 关闭开关（默认）时完全不出现——单机老板用着跟以前一模一样。
import { useState } from 'react'
import { KeyRound, LogIn } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function LoginGate() {
  const staffLoginOn = useAppStore((s) => s.staffLoginOn)
  const currentUser = useAppStore((s) => s.currentUser)
  const staffLogin = useAppStore((s) => s.staffLogin)
  const loginGateOpen = useAppStore((s) => s.loginGateOpen)
  const setLoginGateOpen = useAppStore((s) => s.setLoginGateOpen)
  const setStaffLogin = useAppStore((s) => s.setStaffLogin)
  const loadAll = useAppStore((s) => s.loadAll)

  // 老板模式逃生通道（2026-09-01）：忘了账号密码/误开员工登录时，
  // 老板一键关闭员工登录门直接进入——单机系统老板永远进得来，不会被困在门外
  const enterAsBoss = async () => {
    try {
      await setStaffLogin(false)
      setLoginGateOpen(false)
      // 清掉当前用户状态，老板以未登录身份使用（与 v0.3.4 本地优先一致）
      await loadAll()
    } catch {
      // 关闭失败也强行进——本地单机不应锁死老板
      setLoginGateOpen(false)
    }
  }

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 没开员工登录且没手动打开 / 已登录：门不开
  if ((!staffLoginOn && !loginGateOpen) || currentUser) return null

  const submit = async () => {
    if (busy) return
    if (!username.trim() || !password) {
      setError('登录名和密码都要填')
      return
    }
    setBusy(true)
    setError('')
    try {
      await staffLogin(username.trim(), password)
      setPassword('')
      setLoginGateOpen(false) // 手动登录成功，关闭门
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f2547]">
      <div className="w-96 rounded-2xl bg-white p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-brand-600 text-white">
            <KeyRound className="size-7" />
          </div>
          <h1 className="text-xl font-bold text-slate-800">AI 智能进销存系统</h1>
          <p className="mt-1 text-sm text-slate-500">选人登录，每一笔账都知道是谁记的</p>
        </div>
        <div className="space-y-3">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="登录名"
            autoFocus
          />
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="密码"
          />
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <Button onClick={submit} disabled={busy} className="w-full bg-brand-600 hover:bg-brand-700">
            <LogIn className="size-4" />
            {busy ? '登录中...' : '登录'}
          </Button>
          <p className="text-center text-xs text-slate-400">
            忘了账号密码？找老板在设置页的「员工账号」里处理
          </p>
          <div className="border-t pt-3 text-center">
            <button
              onClick={enterAsBoss}
              className="text-xs font-medium text-brand-600 underline hover:text-brand-700 cursor-pointer"
            >
              老板模式直接进入（关闭员工登录门）
            </button>
            <p className="mt-1 text-[11px] text-slate-400">
              本机单机版，老板随时可以关掉员工登录，不会被困在登录页
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
