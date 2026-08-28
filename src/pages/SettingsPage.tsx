import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { FolderOpen, Info, Key, Moon, Volume2, Type } from 'lucide-react'
import { PageHeader } from '@/components/feedback'
import { backend } from '@/lib/api'
import { APP_VERSION } from '@/lib/version'
import { useLicense, daysText, LEVEL_NAMES } from '@/lib/license'
import { useAppStore } from '@/store/appStore'
import type { BackupStatus } from '@/types'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { BackupCard } from './settings/BackupCard'
import { FeedbackCard } from './settings/FeedbackCard'
import { MobileServerCard, type ServerStatus } from './settings/MobileServerCard'
import { PaymentQrCard } from './settings/PaymentQrCard'
import { StaffCard } from './settings/StaffCard'
import { IndustryTemplateCard } from './settings/IndustryTemplateCard'
import { PreferenceRow } from './settings/PreferenceRow'

interface AppInfo {
  dataDir: string
  dbPath: string
  backupDir: string
  version: string
  lastBackupAt?: number | null
}

export function SettingsPage() {
  const navigate = useNavigate()
  const license = useLicense()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [backing, setBacking] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [backupResult, setBackupResult] = useState('')
  const [error, setError] = useState('')
  // 备份状态（backup:status）：上次时间/份数/第二位置可用性/超期提醒
  const [bStatus, setBStatus] = useState<BackupStatus | null>(null)
  const [extraBusy, setExtraBusy] = useState(false)

  // 使用偏好（本机保存，刷新/重启后仍生效）
  const soundEnabled = useAppStore((s) => s.soundEnabled)
  const setSoundEnabled = useAppStore((s) => s.setSoundEnabled)
  const fontSizeMode = useAppStore((s) => s.fontSizeMode)
  const setFontSizeMode = useAppStore((s) => s.setFontSizeMode)
  const darkMode = useAppStore((s) => s.darkMode)
  const setDarkMode = useAppStore((s) => s.setDarkMode)

  // 自动更新：设置页手动检查
  const [updateChecking, setUpdateChecking] = useState(false)
  const [lastCheckAt, setLastCheckAt] = useState('')
  const [updateMsg, setUpdateMsg] = useState('')
  const checkUpdate = async () => {
    if (updateChecking) return
    setUpdateChecking(true)
    setUpdateMsg('')
    try {
      const r = backend
        ? await backend.invoke('update:check')
        : { version: null, checkedAt: new Date().toISOString() }
      const t = new Date(r.checkedAt)
      setLastCheckAt(`${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`)
      setUpdateMsg(r.version && r.version !== APP_VERSION ? `发现新版本 v${r.version}` : '已是最新')
    } catch {
      setUpdateMsg('检查失败，请稍后再试')
    } finally {
      setUpdateChecking(false)
    }
  }

  // 意见反馈：接收地址（飞书机器人 webhook）存本机 localStorage，提交时随内容一起发给主进程
  const [fbWebhook, setFbWebhook] = useState(() => localStorage.getItem('fi-feedback-webhook') ?? '')
  const [fbMessage, setFbMessage] = useState('')
  const [fbContact, setFbContact] = useState('')
  const [fbBusy, setFbBusy] = useState(false)
  const [fbResult, setFbResult] = useState<{ ok: boolean; text: string } | null>(null)
  const handleSendFeedback = async () => {
    if (!backend) return
    setFbBusy(true)
    setFbResult(null)
    try {
      const r = await backend.invoke('feedback:send', {
        webhook: fbWebhook.trim(),
        message: fbMessage.trim(),
        contact: fbContact.trim(),
      })
      if (r?.ok) {
        setFbResult({ ok: true, text: '已收到，谢谢！' })
        setFbMessage('')
      } else {
        const reason = r?.reason ?? ''
        // 网络类失败说大白话，其余原样带出（如机器人拒收原因）
        const friendly = /timeout|fetch|network|ECONN|ENOTFOUND|ETIMEDOUT|abort/i.test(reason)
          ? '没发出去，检查网络后再试'
          : `没发出去：${reason || '未知原因'}`
        setFbResult({ ok: false, text: friendly })
      }
    } catch {
      setFbResult({ ok: false, text: '没发出去，检查网络后再试' })
    } finally {
      setFbBusy(false)
    }
  }

  // 手机看店：局域网只读服务状态 + 二维码（URL 含访问 token）
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [posQrDataUrl, setPosQrDataUrl] = useState('') // 手机开店 /m/ 二维码
  const [serverBusy, setServerBusy] = useState(false)
  const applyServerStatus = (s: ServerStatus | null) => {
    setServerStatus(s)
    if (s?.url) {
      QRCode.toDataURL(s.url, { width: 220, margin: 1 })
        .then(setQrDataUrl)
        .catch(() => setQrDataUrl(''))
      // 手机开店 /m/ 二维码（全功能操作端）：必须带上访问 token，否则扫码提示要密码
      // s.url 形如 http://ip:port/?token=xxx → mUrl 应为 http://ip:port/m/?token=xxx
      const base = s.url.split('?')[0].replace(/\/$/, '')
      const query = s.url.includes('?') ? '?' + s.url.split('?')[1] : ''
      const mUrl = base + '/m/' + query
      QRCode.toDataURL(mUrl, { width: 220, margin: 1 })
        .then(setPosQrDataUrl)
        .catch(() => setPosQrDataUrl(''))
    } else {
      setQrDataUrl('')
      setPosQrDataUrl('')
    }
  }
  const handleServerToggle = async () => {
    if (!backend || !serverStatus) return
    setServerBusy(true)
    try {
      applyServerStatus(await backend.invoke('server:toggle', { enabled: !serverStatus.enabled }))
    } finally {
      setServerBusy(false)
    }
  }
  const handleRegenerateToken = async () => {
    if (!backend) return
    // 二次确认：旧二维码/书签会一起失效，必须让老板知道后果
    if (!window.confirm('重新生成访问密码后，之前保存的二维码和手机书签都会失效，需要用新二维码重新扫码。确定要换吗？')) return
    setServerBusy(true)
    try {
      applyServerStatus(await backend.invoke('server:regenerateToken'))
    } finally {
      setServerBusy(false)
    }
  }

  useEffect(() => {
    if (backend) {
      backend.invoke('app:info').then(setInfo).catch(() => {})
      backend.invoke('backup:status').then(setBStatus).catch(() => {})
      backend
        .invoke('server:status')
        .then(applyServerStatus)
        .catch(() => {})
    }
  }, [])

  const handleBackup = async () => {
    if (!backend) return
    setBacking(true)
    setError('')
    setBackupResult('')
    try {
      const dest = await backend.invoke('backup:now')
      setBackupResult(dest)
      // 刷新"最近备份时间"显示与备份状态卡片
      backend.invoke('app:info').then(setInfo).catch(() => {})
      backend.invoke('backup:status').then(setBStatus).catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : '备份失败')
    } finally {
      setBacking(false)
    }
  }

  const handleRestore = async () => {
    if (!backend) return
    setRestoring(true)
    setError('')
    setBackupResult('')
    try {
      const r = await backend.invoke('backup:restore')
      // 用户取消选文件或取消二次确认：静默返回，不算错误
      if (r?.cancelled) return
      // 确认恢复后主进程会立刻 relaunch + exit，正常走不到这里
    } catch (e) {
      setError(e instanceof Error ? e.message : '恢复失败')
    } finally {
      setRestoring(false)
    }
  }

  // 选第二备份位置（U 盘/网盘文件夹）：主进程弹系统目录选择，选完直接回最新状态
  const handleSetExtraDir = async () => {
    if (!backend) return
    setExtraBusy(true)
    setError('')
    try {
      const r = await backend.invoke('backup:setExtraDir')
      if (r?.cancelled) return // 用户取消选择：静默
      if (r?.ok) {
        const { ok: _ok, ...status } = r
        setBStatus(status as BackupStatus)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置第二备份位置失败')
    } finally {
      setExtraBusy(false)
    }
  }

  // 取消第二备份位置（已复制过去的备份文件不动，只是以后不再复制）
  const handleClearExtraDir = async () => {
    if (!backend) return
    setExtraBusy(true)
    setError('')
    try {
      const r = await backend.invoke('backup:clearExtraDir')
      if (r?.ok) {
        const { ok: _ok, ...status } = r
        setBStatus(status as BackupStatus)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '取消第二备份位置失败')
    } finally {
      setExtraBusy(false)
    }
  }

  // 超期未备份天数（stale=true 时顶端红条用）
  const staleDays = bStatus?.lastBackupAt
    ? Math.floor((Date.now() - new Date(bStatus.lastBackupAt).getTime()) / 86400000)
    : 0

  return (
    <div className="space-y-6">
      <PageHeader title="设置" subtitle="数据备份、存储位置与系统信息" />

      {/* 使用偏好：提示音 + 大字模式，本机保存 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Volume2 className="size-5 text-brand-500" />
            使用偏好
          </CardTitle>
          <CardDescription>只存在这台电脑上，不影响数据，随时可以改回来。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <PreferenceRow
            icon={<Volume2 className="size-4 text-slate-500" />}
            title="操作提示音"
            description="入库、出库、盘点成功/失败，扫码识别到商品时都有声音，不用盯着屏幕看成败"
            checked={soundEnabled}
            onToggle={() => setSoundEnabled(!soundEnabled)}
          />
          <PreferenceRow
            icon={<Type className="size-4 text-slate-500" />}
            title="大字模式（看得更清楚）"
            description="全站字号放大一档，适合离屏幕远一点操作"
            checked={fontSizeMode === 'large'}
            onToggle={() => setFontSizeMode(fontSizeMode === 'large' ? 'normal' : 'large')}
          />
          <PreferenceRow
            icon={<Moon className="size-4 text-slate-500" />}
            title="深色模式（打烊了也不刺眼）"
            description="界面换成深蓝黑底，晚上守店、关店结账时眼睛舒服些"
            checked={darkMode}
            onToggle={() => setDarkMode(!darkMode)}
          />
        </CardContent>
      </Card>

      {/* 行业模板（通用版）：一键切换行业 */}
      <IndustryTemplateCard />

      {/* 数据备份 */}
      <BackupCard
        hasBackend={!!backend}
        backupDir={info?.backupDir}
        bStatus={bStatus}
        staleDays={staleDays}
        backing={backing}
        restoring={restoring}
        extraBusy={extraBusy}
        backupResult={backupResult}
        error={error}
        onBackup={handleBackup}
        onRestore={handleRestore}
        onSetExtraDir={handleSetExtraDir}
        onClearExtraDir={handleClearExtraDir}
      />

      {/* 手机看店：局域网只读服务，微信扫码看账 */}
      <MobileServerCard
        serverStatus={serverStatus}
        qrDataUrl={qrDataUrl}
        posQrDataUrl={posQrDataUrl}
        serverBusy={serverBusy}
        onToggle={() => void handleServerToggle()}
        onRegenerateToken={handleRegenerateToken}
      />

      {/* 收款码：手机端开单选微信/支付宝时展示给顾客扫 */}
      <PaymentQrCard />

      {/* 员工账号（v0.1）：多用户登录 + 老板/店员角色 */}
      <StaffCard />

      {/* 意见反馈 */}
      <FeedbackCard
        hasBackend={!!backend}
        message={fbMessage}
        onMessageChange={setFbMessage}
        contact={fbContact}
        onContactChange={setFbContact}
        webhook={fbWebhook}
        onWebhookChange={(v) => {
          setFbWebhook(v)
          localStorage.setItem('fi-feedback-webhook', v)
        }}
        busy={fbBusy}
        result={fbResult}
        onSend={handleSendFeedback}
      />

      {/* 数据位置 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderOpen className="size-5 text-brand-500" />
            数据位置
          </CardTitle>
          <CardDescription>
            数据库为单文件 SQLite（WAL 模式），迁移门店电脑时复制整个数据目录即可。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {info ? (
            <div className="space-y-2 text-sm">
              <div className="grid grid-cols-[90px_1fr] gap-y-2">
                <span className="text-muted-foreground">数据库</span>
                <span className="font-mono text-xs break-all">{info.dbPath}</span>
                <span className="text-muted-foreground">备份目录</span>
                <span className="font-mono text-xs break-all">{info.backupDir}</span>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {backend ? '读取中...' : '浏览器开发模式暂无本地数据文件'}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 激活与授权 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Key className="size-5 text-amber-500" />
            激活与授权
          </CardTitle>
          <CardDescription>
            {license.activated
              ? `${LEVEL_NAMES[license.level] ?? '普通版'} 已激活 · ${daysText(license.daysLeft)}`
              : '普通版 · 免费，语音输入/云备份/收款对账全开放'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-1 text-sm">
              <div className="text-slate-600">
                状态：
                <span className={license.activated ? 'font-medium text-green-700' : 'text-slate-500'}>
                  {license.activated ? `${LEVEL_NAMES[license.level] ?? '普通版'} · ${daysText(license.daysLeft)}` : '普通版'}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                机器 ID：{license.machineId || '仅桌面端可用'}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => navigate('/onboarding')}
                className="rounded bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 cursor-pointer"
              >
                新手引导
              </button>
              <button
                onClick={() => navigate('/activate')}
                className="rounded bg-brand-100 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-200 cursor-pointer"
              >
                {license.activated ? '管理授权' : '升级进阶版'}
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 关于 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Info className="size-5 text-brand-500" />
            关于
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-slate-600">
          <div>通用进销存系统 v{APP_VERSION}</div>
          <div className="text-xs text-muted-foreground">
            Electron + React + SQLite（WAL）· 本地单机部署 · 断电不丢数据
          </div>
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={checkUpdate}
              disabled={updateChecking}
              className="rounded bg-brand-100 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-200 disabled:opacity-50 cursor-pointer"
            >
              {updateChecking ? '检查中...' : '检查更新'}
            </button>
            {lastCheckAt && (
              <span className="text-xs text-muted-foreground">
                上次检查 {lastCheckAt}，{updateMsg}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
