import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Cloud, Copy, RefreshCw, Download, Key, CheckCircle, XCircle, AlertTriangle } from 'lucide-react'
import { backend, isGuestMode, setGuestMode } from '@/lib/api'
import { useAppStore } from '@/store/appStore'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function CloudCard() {
  const cloud = useAppStore((s) => s.cloud)
  const setCloud = useAppStore((s) => s.setCloud)
  // 游客模式（跳过登录）：强制显示登录表单，允许随时登录/切换账号
  // 每次渲染读取 localStorage 标记（登录后 setCloud 触发重渲染，自动退出游客界面）
  const guestMode = isGuestMode()

  const [pairCode, setPairCode] = useState('')
  const [pairing, setPairing] = useState(false)
  // 多设备账户登录（v2）：注册/登录绑定本机
  const [acctMode, setAcctMode] = useState<'login' | 'register'>('login')
  const [acctUsername, setAcctUsername] = useState('')
  const [acctPassword, setAcctPassword] = useState('')
  const [acctBusy, setAcctBusy] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [storeName, setStoreName] = useState('')
  const [storeNameSaved, setStoreNameSaved] = useState(false)
  // B2: 备份列表 + 恢复确认
  const [backups, setBackups] = useState<{ date: string; size: number }[]>([])
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [restoreDate, setRestoreDate] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (!backend) return
    backend.invoke('cloud:status').then((s) => {
      if (s) setCloud(s)
    }).catch(() => {})
  }, [setCloud])

  useEffect(() => {
    if (!cloud.viewUrl) { setQrDataUrl(''); return }
    QRCode.toDataURL(cloud.viewUrl, { width: 200, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => {})
  }, [cloud.viewUrl])

  const handlePair = async () => {
    const code = pairCode.trim().toUpperCase()
    if (!code || !backend || pairing) return
    setPairing(true)
    try {
      const r = await backend.invoke('cloud:pair', { pairCode: code })
      if (r?.ok) {
        setCloud({ paired: true, viewUrl: r.viewUrl, error: null })
      } else {
        setCloud({ error: r?.error || '配对失败' })
      }
    } catch (e) {
      setCloud({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setPairing(false)
    }
  }

  const handleAccount = async () => {
    if (!backend || acctBusy || !acctUsername.trim() || acctPassword.length < 6) return
    setAcctBusy(true)
    try {
      const deviceName = `${navigator.platform} ${new Date().toLocaleDateString('zh-CN')}`
      const r = acctMode === 'register'
        ? await backend.invoke('cloud:registerAccount', { username: acctUsername.trim(), password: acctPassword, deviceName })
        : await backend.invoke('cloud:loginAccount', { username: acctUsername.trim(), password: acctPassword, deviceName })
      if (r?.ok) {
        setGuestMode(false) // 清除 localStorage 游客标记
        useAppStore.setState({ cloudAuth: 'logged' }) // 退出游客模式
        setCloud({ paired: true, username: r.username ?? null, viewUrl: r.viewUrl, error: null })
        setAcctPassword('')
      } else {
        setCloud({ error: r?.error || (acctMode === 'register' ? '注册失败' : '登录失败') })
      }
    } catch (e) {
      setCloud({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setAcctBusy(false)
    }
  }

  const handleSyncNow = async () => {
    if (!backend || cloud.syncing) return
    setCloud({ syncing: true, error: null })
    try {
      await backend.invoke('cloud:syncNow')
      const s = await backend.invoke('cloud:status')
      if (s) setCloud(s)
    } catch (e) {
      setCloud({ syncing: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // 同步冲突（另一台电脑有新数据）时用户选择"保留本机"：强制把本机统计快照覆盖上去
  const handleResolveConflict = async () => {
    if (!backend) return
    try {
      await backend.invoke('cloud:resolveConflict')
      const s = await backend.invoke('cloud:status')
      if (s) setCloud(s)
    } catch (e) {
      setCloud({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleRegenLink = async () => {
    if (!backend) return
    try {
      const r = await backend.invoke('cloud:regenViewLink')
      if (r?.ok) {
        setCloud({ viewUrl: r.viewUrl, error: null })
      } else {
        setCloud({ error: r?.error || '吊销失败' })
      }
    } catch (e) {
      setCloud({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleListBackups = async () => {
    if (!backend) return
    setBackupsLoading(true)
    try {
      const r = await backend.invoke('cloud:listBackups')
      if (r?.ok && r.files) setBackups(r.files)
    } catch { return }
    finally { setBackupsLoading(false) }
  }

  const handleRestore = async (date: string) => {
    if (!backend || restoring) return
    setRestoring(true)
    try {
      const r = await backend.invoke('cloud:restore', { date })
      if (!r?.ok) {
        setCloud({ error: r?.error || '恢复失败' })
      }
      // 成功时 app.relaunch 会关闭窗口，不需要额外处理
    } catch (e) {
      setCloud({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setRestoring(false)
      setRestoreDate(null)
    }
  }

  // 退出登录（解绑本机）：清空本地凭证，回到未配对可重新登录
  const [logoutConfirm, setLogoutConfirm] = useState(false)
  const handleLogout = async () => {
    if (!backend) return
    try {
      await backend.invoke('cloud:logout')
      setGuestMode(false)
      // 退出登录后回到本地模式（CloudCard 显示登录表单，不弹全屏门）
      useAppStore.setState({ cloudAuth: 'local' })
      setCloud({
        paired: false, username: null, lastSyncAt: null, lastBackupAt: null,
        syncing: false, error: null, viewUrl: null,
      })
      setLogoutConfirm(false)
      setQrDataUrl('')
      setStoreName('')
    } catch (e) {
      setCloud({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="size-5 text-lake-500" />
            云备份 · 远程看店
          </CardTitle>
          <CardDescription>
            {cloud.paired
              ? `已配对${cloud.lastSyncAt ? ' · 上次同步 ' + new Date(cloud.lastSyncAt).toLocaleTimeString('zh-CN') : ''}`
              : '输入配对码连接云端服务（云备份/换机恢复全版本开放）'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 未配对 或 游客模式：显示账户登录（多设备）或配对码 */}
          {(!cloud.paired || guestMode) && (
            <div className="space-y-4">
              {/* 多设备账户：一个账户多台电脑 */}
              <div className="rounded-lg border border-lake-100 bg-lake-50/60 p-3">
                <div className="mb-2 flex gap-1">
                  <button
                    className={`rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${acctMode === 'login' ? 'bg-lake-600 text-white' : 'bg-lake-100 text-lake-700'}`}
                    onClick={() => setAcctMode('login')}
                  >登录账户</button>
                  <button
                    className={`rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${acctMode === 'register' ? 'bg-lake-600 text-white' : 'bg-lake-100 text-lake-700'}`}
                    onClick={() => setAcctMode('register')}
                  >注册账户</button>
                </div>
                <div className="space-y-2">
                  <Input
                    value={acctUsername}
                    onChange={(e) => setAcctUsername(e.target.value)}
                    placeholder="账户名（店名，多台电脑用同一个）"
                    className="h-9 text-sm"
                  />
                  <Input
                    value={acctPassword}
                    onChange={(e) => setAcctPassword(e.target.value)}
                    placeholder={acctMode === 'register' ? '设置密码（至少 6 位）' : '账户密码'}
                    type="password"
                    className="h-9 text-sm"
                    onKeyDown={(e) => e.key === 'Enter' && handleAccount()}
                  />
                  <Button onClick={handleAccount} disabled={acctBusy || acctUsername.trim().length < 2 || acctPassword.length < 6} size="sm" className="w-full">
                    {acctBusy ? '处理中...' : acctMode === 'register' ? '注册并登录（绑定本机）' : '登录（绑定本机）'}
                  </Button>
                  <div className="text-[11px] text-slate-500">
                    {acctMode === 'register'
                      ? '注册一次，之后每台电脑都用同一账户登录，数据自动共享'
                      : '多台电脑用同一账户登录，各自同步共享云端数据'}
                  </div>
                </div>
              </div>

              {/* 配对码（老方式） */}
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-slate-200" />
                <span className="text-[11px] text-slate-400">或使用配对码</span>
                <div className="h-px flex-1 bg-slate-200" />
              </div>
              <div>
                <div className="mb-1 text-xs text-slate-500">配对码（从老板管理页获取）</div>
                <div className="flex gap-2">
                  <Input
                    value={pairCode}
                    onChange={(e) => setPairCode(e.target.value)}
                    placeholder="输入 6 位配对码"
                    className="font-mono text-sm uppercase"
                    maxLength={6}
                    onKeyDown={(e) => e.key === 'Enter' && handlePair()}
                  />
                  <Button onClick={handlePair} disabled={pairing || pairCode.length < 6} size="sm">
                    {pairing ? '配对中...' : '连接'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* 已配对（且非游客）：管理 */}
          {cloud.paired && !guestMode && (
            <div className="space-y-4">
              {/* 当前登录账号 */}
              <div className="flex items-center gap-2 rounded-lg border border-lake-100 bg-lake-50/70 px-3 py-2.5">
                <CheckCircle className="size-4 shrink-0 text-lake-600" />
                <span className="text-sm text-slate-700">
                  已登录账号：<span className="font-bold text-lake-700">{cloud.username ?? '（本地已配对）'}</span>
                </span>
                <span className="ml-auto text-xs text-slate-400">
                  多台电脑用同一账号登录，数据自动互通
                </span>
              </div>

              {/* 店名 */}
              <div className="flex gap-2">
                <Input
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  placeholder="设置店名（手机看店页显示）"
                  className="text-sm"
                />
                <Button onClick={() => { setStoreNameSaved(true); setTimeout(() => setStoreNameSaved(false), 2000) }} size="sm" variant="outline">
                  {storeNameSaved ? <CheckCircle className="size-4 text-green-500" /> : '保存'}
                </Button>
              </div>

              {/* 二维码 */}
              {qrDataUrl && (
                <div className="flex flex-col items-center gap-2">
                  <img src={qrDataUrl} alt="远程看店二维码" className="h-36 w-36 rounded-lg border" />
                  <div className="text-xs text-slate-400">微信扫一扫，远程看店</div>
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleSyncNow} disabled={cloud.syncing} size="sm" variant="outline">
                  <RefreshCw className={`size-4 ${cloud.syncing ? 'animate-spin' : ''}`} />
                  立即同步
                </Button>
                <Button onClick={handleListBackups} disabled={backupsLoading} size="sm" variant="outline">
                  <Download className="size-4" />
                  云端备份
                </Button>
                <Button onClick={handleRegenLink} size="sm" variant="outline">
                  <Key className="size-4" />
                  重新生成链接
                </Button>
              </div>

              {/* 云端备份列表 */}
              {backups.length > 0 && (
                <div className="rounded-lg border border-slate-200">
                  <div className="border-b bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500">
                    云端备份（最近 {backups.length} 份，点击恢复）
                  </div>
                  <div className="max-h-48 overflow-auto">
                    {backups.map((b) => (
                      <div key={b.date} className="flex items-center justify-between border-b border-slate-100 px-3 py-2 last:border-b-0">
                        <div>
                          <span className="text-sm text-slate-700">{b.date}</span>
                          <span className="ml-2 text-xs text-slate-400">{(b.size / 1024).toFixed(0)} KB</span>
                        </div>
                        <Button
                          onClick={() => setRestoreDate(b.date)}
                          disabled={restoring}
                          size="sm"
                          variant="ghost"
                          className="text-xs"
                        >
                          恢复
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 恢复确认 */}
              {restoreDate && (
                <div className="rounded-lg border-2 border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-amber-800">
                    <AlertTriangle className="size-4" />
                    确认恢复备份？
                  </div>
                  <div className="mt-1 text-xs text-amber-700">
                    将把全部数据替换为 {restoreDate} 的云端备份。当前数据会自动留底一份，但恢复后软件会重启。
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button onClick={() => handleRestore(restoreDate)} disabled={restoring} size="sm" className="bg-amber-600 hover:bg-amber-700">
                      {restoring ? '恢复中...' : '确认恢复'}
                    </Button>
                    <Button onClick={() => setRestoreDate(null)} size="sm" variant="outline">
                      取消
                    </Button>
                  </div>
                </div>
              )}

              {/* 复制链接 */}
              {cloud.viewUrl && (
                <button
                  onClick={() => { navigator.clipboard.writeText(cloud.viewUrl!).catch(() => {}) }}
                  className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 cursor-pointer"
                >
                  <Copy className="size-3" />
                  复制远程看店链接
                </button>
              )}

              {/* 退出登录：解绑本机，可重新登录其他账户 */}
              <div className="border-t border-slate-100 pt-3">
                {logoutConfirm ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-600">确认退出登录并解绑本机？</span>
                    <Button onClick={handleLogout} size="sm" className="bg-red-600 hover:bg-red-700 text-white">确认退出</Button>
                    <Button onClick={() => setLogoutConfirm(false)} size="sm" variant="outline">取消</Button>
                  </div>
                ) : (
                  <Button onClick={() => setLogoutConfirm(true)} size="sm" variant="ghost" className="text-red-500 hover:text-red-600 hover:bg-red-50">
                    退出登录（解绑本机）
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* 错误提示 */}
          {cloud.error && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
              <XCircle className="size-3 shrink-0" />
              <span className="min-w-0 flex-1">{cloud.error}</span>
              {cloud.error.includes('同步冲突') && (
                <button onClick={handleResolveConflict} className="shrink-0 rounded-md bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-500 cursor-pointer">
                  仍要覆盖本机数据
                </button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
  )
}
