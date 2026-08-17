import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Cloud, Copy, RefreshCw, Download, Key, CheckCircle, XCircle, AlertTriangle } from 'lucide-react'
import { backend } from '@/lib/api'
import { useAppStore } from '@/store/appStore'
import { ProGate } from '@/components/ProGate'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function CloudCard() {
  const cloud = useAppStore((s) => s.cloud)
  const setCloud = useAppStore((s) => s.setCloud)

  const [pairCode, setPairCode] = useState('')
  const [pairing, setPairing] = useState(false)
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

  return (
    <ProGate
      featureDesc="关店后手机随时看今天卖了多少钱、毛利多少、什么货快断了。数据加密上传，连我们都看不到你的账。"
    >
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="size-5 text-sky-500" />
            云备份 · 远程看店
          </CardTitle>
          <CardDescription>
            {cloud.paired
              ? `已配对${cloud.lastSyncAt ? ' · 上次同步 ' + new Date(cloud.lastSyncAt).toLocaleTimeString('zh-CN') : ''}`
              : '输入配对码连接云端服务（云备份/换机恢复全版本开放）'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 未配对：输入配对码 */}
          {!cloud.paired && (
            <div className="space-y-3">
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

          {/* 已配对：管理 */}
          {cloud.paired && (
            <div className="space-y-4">
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
            </div>
          )}

          {/* 错误提示 */}
          {cloud.error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
              <XCircle className="size-3" />
              {cloud.error}
            </div>
          )}
        </CardContent>
      </Card>
    </ProGate>
  )
}
