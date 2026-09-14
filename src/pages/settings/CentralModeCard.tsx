// 云端中心库（P2）：桌面软件改连 cloud /app，读写全走中心库——多台/多地共用同一本账；关闭则只用本机数据。
//
// 方案C（2026-09-14 owner 拍板）：**手填 URL + token 不再是常规入口**。
//   · 常规视图只回答一件事「连没连上」+ 一个动作「断开」，并用大白话说明连上以后是什么效果；
//   · 没连上时直接告诉用户去哪登录（登录后由 cloud:centralConfig 自动下发地址与 token，
//     CloudCard 登录成功后就会调它并重启生效）；
//   · 手动填地址/token 收进「高级设置」（advanced=true）—— 留给排障与《中心库归一 Runbook》的
//     紧急路径，普通店老板不该看见 token 输入框。
// 注：Layout.tsx 里那条「首启强制填 token 的全屏门」在 2026-09-13 已删除，理由与此相同。
//
// 与方案A的关系：连上中心库后，主进程会停掉「整库快照/整库每日备份」（见 electron/cloud.js 的
// wholeDbUploadBlocked）——因为本机 data.db 此时不是权威账本。所以下面那句提醒是如实告知，不是吓人。
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Cloud, Unplug } from 'lucide-react'
import { getCentralConfig, setCentralConfig } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function CentralModeCard({ advanced = false }: { advanced?: boolean }) {
  const nav = useNavigate()
  const cur = getCentralConfig()
  const [url, setUrl] = useState(cur.url || 'https://app.junchengzn.com')
  const [token, setToken] = useState(cur.token)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const on = !!cur.url && !!cur.token

  const save = () => {
    if (!url.trim()) { setMsg('请填中心库地址，例如 https://app.junchengzn.com'); return }
    if (!token.trim()) { setMsg('请填访问 token（从中心库获取）'); return }
    setSaving(true)
    try {
      setCentralConfig(url.trim().replace(/\/$/, ''), token.trim())
      setMsg('已保存，正在重启以使「连接云端中心库」生效...')
      setTimeout(() => window.location.reload(), 800)
    } catch {
      setMsg('保存失败')
      setSaving(false)
    }
  }

  const clear = () => { setCentralConfig('', ''); window.location.reload() }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Cloud className="size-5 text-brand-500" />
          云端中心库
          <span className={'rounded-full px-2 py-0.5 text-[11px] font-bold ' + (on ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
            {on ? '已连接' : '未连接'}
          </span>
        </CardTitle>
        <CardDescription>
          {on
            ? '全店的货和账都放在云上那一份，几台电脑看到的是同一本账。'
            : '现在用的是这台电脑自己的数据；连上中心库后，几台电脑共用一份账。'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {on ? (
          <>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              中心库地址：<span className="text-slate-700">{cur.url}</span>
            </div>
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              连上中心库后，这台电脑不再往云上传「整机数据」——手机看板的快照和每日整机备份都已暂停。
              原因是：你界面上看到的是中心库那份，而本机这份是旧的，传上去会把云端的覆盖掉。
            </div>
            <Button onClick={clear} size="sm" variant="outline">
              <Unplug className="size-4" />
              断开（回到本机数据）
            </Button>
          </>
        ) : (
          <>
            <div className="text-sm text-slate-600">
              还没连中心库。到「账号」页登录一次，软件会自己把中心库配好 —— 不用抄地址和 token。
            </div>
            <Button onClick={() => nav('/account')} size="sm">去「账号」页登录</Button>
          </>
        )}

        {/* 手动填地址/token：只在「高级设置」里出现（排障/紧急切换用），常规界面不出现 token 输入框 */}
        {advanced && (
          <div className="space-y-2 border-t pt-3">
            <div className="text-xs text-slate-500">
              手动配置（平时不用动这一栏：登录后会自动配好；这里的地址和 token 一般只有排障时才用手填）
            </div>
            <div>
              <div className="mb-1 text-xs text-slate-500">中心库地址</div>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.junchengzn.com" className="text-sm" />
            </div>
            <div>
              <div className="mb-1 text-xs text-slate-500">访问 Token</div>
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="从中心库获取的 token" type="password" className="text-sm" />
            </div>
            <div className="flex gap-2">
              <Button onClick={save} disabled={saving} size="sm" variant="outline">{saving ? '保存中...' : '保存并连接'}</Button>
            </div>
            <div className="text-xs text-slate-500">
              每台电脑用同一套「地址 + token」，即多点实时共享同一份中心库数据。改后需重启软件生效。
            </div>
          </div>
        )}

        {msg && <div className="text-xs text-slate-500">{msg}</div>}
      </CardContent>
    </Card>
  )
}
