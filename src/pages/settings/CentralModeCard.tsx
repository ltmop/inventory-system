// 连接云端中心库（P2）：桌面软件改连 cloud /app，读写全走中心库——多台/多地实时共享；关闭则用本机数据。
import { useState } from 'react'
import { Cloud } from 'lucide-react'
import { getCentralConfig, setCentralConfig } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function CentralModeCard() {
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
          连接云端中心库
          {on && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700">已连接</span>}
        </CardTitle>
        <CardDescription>
          开启后本软件改连云端中心库（app.junchengzn.com）——多台电脑/多地数据实时共享；关闭则只用本机数据。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <div>
            <div className="mb-1 text-xs text-slate-500">中心库地址</div>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.junchengzn.com" className="text-sm" />
          </div>
          <div>
            <div className="mb-1 text-xs text-slate-500">访问 Token</div>
            <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="从中心库获取的 token" type="password" className="text-sm" />
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={save} disabled={saving} size="sm">{saving ? '保存中...' : '保存并连接'}</Button>
          {on && <Button onClick={clear} size="sm" variant="outline">断开（回本机数据）</Button>}
        </div>
        {msg && <div className="text-xs text-slate-500">{msg}</div>}
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          每台电脑用同一套「地址 + token」配置，即多点实时共享同一份中心库数据。改后需重启软件生效。
        </div>
      </CardContent>
    </Card>
  )
}
