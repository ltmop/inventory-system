import { useState } from 'react'
import { Check, Copy, Monitor, QrCode, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PreferenceRow } from './PreferenceRow'

/** 手机看店服务状态（server:status 通道返回） */
export interface ServerStatus {
  enabled: boolean
  running: boolean
  port: number | null
  ip: string
  url: string | null
  /** HTTPS 是否可用（语音/摄像头识别必需） */
  httpsEnabled?: boolean
  /** 纯 HTTP 地址（HTTPS 不可用时兜底） */
  httpUrl?: string | null
  /** 局域网全功能版地址（桌面应用被打包到 dist 时才有） */
  appUrl?: string | null
  error?: string | null
}

interface MobileServerCardProps {
  serverStatus: ServerStatus | null
  qrDataUrl: string
  posQrDataUrl?: string
  serverBusy: boolean
  onToggle: () => void
  onRegenerateToken: () => void
}

/** 手机看店卡片：局域网只读服务，微信扫码看账 + 手机开店 /m/ 全功能操作端 */
export function MobileServerCard({
  serverStatus,
  qrDataUrl,
  posQrDataUrl,
  serverBusy,
  onToggle,
  onRegenerateToken,
}: MobileServerCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <QrCode className="size-5 text-brand-500" />
          手机看店
          {serverStatus?.running && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-700">
              运行中
            </span>
          )}
        </CardTitle>
        <CardDescription>
          出门或在家用手机看店里的账：今日营业额、低库存、查货位、今日流水。只读，手机上改不了数据。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <PreferenceRow
          icon={<QrCode className="size-4 text-slate-500" />}
          title="手机看店服务"
          description="开启后，连同一个 WiFi 的手机扫码就能看店里的账；关掉后手机立即访问不了"
          checked={!!serverStatus?.enabled}
          onToggle={onToggle}
        />
        {serverStatus?.running && serverStatus.url && (
          <div className="flex flex-wrap items-start gap-5 rounded-lg bg-slate-50 px-4 py-4">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="手机看店二维码" className="size-[180px] rounded-lg border bg-white p-1" />
            ) : (
              <div className="flex size-[180px] items-center justify-center rounded-lg border bg-white text-xs text-muted-foreground">
                二维码生成中…
              </div>
            )}
            <div className="space-y-2 text-sm">
              <div className="font-medium text-slate-800">微信「扫一扫」扫这个二维码，直接打开看店页面</div>
              <div className="text-muted-foreground">
                服务地址：<span className="font-mono text-xs text-brand-700">{`http://${serverStatus.ip}:${serverStatus.port}`}</span>
              </div>
            <div className="space-y-1 text-xs text-muted-foreground">
                <p>· 手机要和这台电脑连同一个 WiFi 才打得开。</p>
                <p>· 首次使用如弹出 Windows 防火墙提示，请点「允许」。</p>
                {serverStatus?.httpsEnabled && (
                  <p className="text-amber-700">
                    · 链接用的是 https（语音/摄像头识别需要）。第一次打开手机会提示「连接不是私密连接」→ 点「高级」→「继续访问」，只需这一次。
                  </p>
                )}
                <p>· 页面每 30 秒自动刷新；可以把页面「添加到主屏幕」，像个小的看店 App。</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={onRegenerateToken}
                disabled={serverBusy}
              >
                <RefreshCw className="size-3.5" />
                重新生成访问密码
              </Button>
              <p className="text-xs text-muted-foreground">
                怀疑链接泄露时点这个；旧二维码和手机书签会一起失效。
              </p>
            </div>
          </div>
        )}
        {/* 手机开店 /m/ 全功能操作端 */}
        {serverStatus?.running && serverStatus.url && posQrDataUrl && (
          <div className="flex flex-wrap items-start gap-5 rounded-lg bg-blue-50 px-4 py-4">
            {posQrDataUrl ? (
              <img src={posQrDataUrl} alt="手机开店二维码" className="size-[180px] rounded-lg border bg-white p-1" />
            ) : (
              <div className="flex size-[180px] items-center justify-center rounded-lg border bg-white text-xs text-muted-foreground">
                二维码生成中…
              </div>
            )}
            <div className="space-y-2 text-sm">
              <div className="font-medium text-slate-800">手机开店 · 全功能操作端</div>
              <div className="text-muted-foreground">
                手机扫码开单、入库、查库存、看今日账——和电脑上一样用，专门给手机做了优化
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>· 开了店里的 WiFi 就能用，不花流量。</p>
                <p>· 可以「添加到主屏幕」，桌面上会多个「进销存」APP 图标。</p>
              </div>
            </div>
          </div>
        )}
        {serverStatus?.running && serverStatus.appUrl && (
          <LanAppUrlBlock appUrl={serverStatus.appUrl} />
        )}
        {serverStatus?.enabled && !serverStatus.running && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
            服务已开启但当前没在运行{serverStatus.error ? `：${serverStatus.error}` : '（端口可能被占用，重启软件试试）'}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** 局域网全功能版地址块：电脑/平板浏览器打开，和主机上一样能用（开单、入库、盘点） */
function LanAppUrlBlock({ appUrl }: { appUrl: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(appUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('复制失败，请手动复制下面的地址：', appUrl)
    }
  }
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-800">
        <Monitor className="size-4 text-brand-500" />
        电脑 / 平板用全功能版
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="max-w-full break-all rounded border bg-white px-2 py-1 font-mono text-xs text-brand-700">
          {appUrl}
        </code>
        <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
          {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
          {copied ? '已复制' : '复制地址'}
        </Button>
      </div>
      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        <p>· 店里其他电脑或平板连同一个 WiFi，用浏览器打开这个地址，就能开单、入库、盘点，和这台主机上操作一样。</p>
        <p>· 拍照识别、语音助手、备份恢复这些主机本地功能，在浏览器里用不了，要回到主机操作。</p>
        <p>· 这个地址带访问密码，别发给店外的人。</p>
      </div>
    </div>
  )
}
