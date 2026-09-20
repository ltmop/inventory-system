import { useEffect, useState } from 'react'
import { Plug } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { backend } from '@/lib/api'
import { useOnline } from '@/lib/useOnline'

interface Provider {
  key: string
  name: string
  model: string
  baseUrl?: string
  defaultBaseUrl?: string
  defaultModel?: string
  configured: boolean
  official?: boolean
  customized?: boolean
  vision?: string | null
  defaultVision?: string | null
  note?: string
}

/**
 * AI 大模型接入（设置页）：内部支持接入 DeepSeek 等 —— **只要「API 地址 + 密钥」**。
 * 保存后会调用 ai:setEndpoint / ai:setKey，并尽力同步到中心库（手机端「小渔」用同一个模型）。
 */
export function AiModelCard() {
  const online = useOnline()
  const [providers, setProviders] = useState<Provider[]>([])
  const [provider, setProvider] = useState('deepseek')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [visionModel, setVisionModel] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const cur = providers.find((p) => p.key === provider)
  const list = providers.filter((p) => !p.official)

  useEffect(() => {
    if (!backend) return
    backend.invoke('ai:providers').then((l) => setProviders((l as Provider[]) ?? [])).catch(() => {})
    backend.invoke('ai:status').then((s) => {
      if (s?.providerKey && !s?.official) setProvider(s.providerKey)
      if (s?.baseUrl) setBaseUrl(s.baseUrl)
      if (s?.model) setModel(s.model)
    }).catch(() => {})
  }, [])

  const save = async () => {
    if (!backend) return
    setBusy(true)
    setMsg(null)
    try {
      if (baseUrl.trim() || model.trim() || visionModel.trim()) {
        await backend.invoke('ai:setEndpoint', {
          provider,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          visionModel: visionModel.trim(),
        })
      }
      if (keyInput.trim()) await backend.invoke('ai:setKey', { key: keyInput.trim() })
      const t = await backend.invoke('ai:test')
      let note = ''
      if (t?.ok) {
        try {
          const s = await backend.invoke('ai:syncCentral')
          note = s?.ok
            ? ' 已同步到中心库：手机端「小渔」也用这个模型。'
            : s?.reason === 'not-central'
              ? ' （本机模式：手机端仍走官方 AI 服务）'
              : ` 同步到手机端失败：${s?.reason ?? '未知原因'}。`
        } catch { /* 同步失败不影响本机使用 */ }
      }
      setMsg(
        t?.ok
          ? { ok: true, text: `验证通过，已启用「${cur?.name ?? provider}」。${note}` }
          : { ok: false, text: `验证失败（${t?.reason ?? '未知原因'}）：检查 API 地址、密钥是否正确，以及账户是否有余额。` },
      )
      if (t?.ok) setKeyInput('')
      const fresh = await backend.invoke('ai:providers').catch(() => null)
      if (fresh) setProviders(fresh as Provider[])
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Plug className="size-5 text-brand-500" />
          AI 大模型接入
          {cur?.customized && (
            <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-normal text-brand-700">已自定义地址</span>
          )}
        </CardTitle>
        <CardDescription>
          接入自己的大模型（推荐 DeepSeek）：<b>只要填「API 地址 + 密钥」</b>。保存后 AI 问答、打烊日报、
          进货单识别都走这个模型；若这台电脑连着中心库，会自动同步过去，手机端「小渔」用同一个模型。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-muted-foreground">模型</span>
          <Select value={provider} onValueChange={setProvider} disabled={!backend || busy}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              {list.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.name}
                  {p.configured ? '（已配 Key）' : '（未配 Key）'}
                  {p.note ? ` · ${p.note}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">默认 DeepSeek：官方地址 https://api.deepseek.com</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="w-16 text-sm font-medium text-muted-foreground">API 地址</span>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={cur?.baseUrl || cur?.defaultBaseUrl || 'https://api.deepseek.com'}
            className="w-[22rem] font-mono text-xs"
            disabled={!backend}
          />
          <span className="text-xs text-muted-foreground">留空用默认；自建 / 中转地址也填这里</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="w-16 text-sm font-medium text-muted-foreground">密钥</span>
          <Input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={cur?.configured ? '已保存（输入新 Key 可替换）' : '粘贴 API Key（DeepSeek 以 sk- 开头）'}
            className="w-[22rem] font-mono text-xs"
            disabled={!backend}
          />
          <span className="text-xs text-muted-foreground">模型名（可选）</span>
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={cur?.model || cur?.defaultModel || 'deepseek-chat'}
            className="w-40 font-mono text-xs"
            disabled={!backend}
          />
          <Button
            onClick={save}
            disabled={!backend || busy || !online || (!keyInput.trim() && !baseUrl.trim() && !model.trim() && !visionModel.trim())}
            className="bg-brand-600 hover:bg-brand-700"
          >
            {busy ? '验证中...' : '保存并验证'}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="w-16 text-sm font-medium text-muted-foreground">视觉模型</span>
          <Input
            value={visionModel}
            onChange={(e) => setVisionModel(e.target.value)}
            placeholder={cur?.vision || cur?.defaultVision || 'deepseek-v4-flash-vision-exp'}
            className="w-[22rem] font-mono text-xs"
            disabled={!backend}
          />
          <span className="text-xs text-muted-foreground">
            拍照建档 / 进货单识图用；DeepSeek 视觉模型官方叫 <span className="font-mono">deepseek-v4-flash-vision-exp</span>（留空用默认）
          </span>
        </div>

        {msg && (
          <div className={`rounded-lg px-4 py-3 text-sm ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {msg.text}
          </div>
        )}
        {!online && <p className="text-xs text-amber-600">当前离线：验证需要联网，请连上网再保存。</p>}
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-muted-foreground">
          <div className="font-medium text-slate-700">哪档最省？</div>
          <p className="mt-1">
            · <b>不花钱</b>：继续用「阿东官方AI」（内置连接码，免费额度）；或选 <b>智谱 GLM-4-Flash</b>（官方免费档，支持工具调用）。
          </p>
          <p>· <b>最便宜的自备 Key</b>：<b>DeepSeek deepseek-flash</b> —— 每百万 token 输入 ¥1 / 输出 ¥4（空闲时段半价，含周末全天），自带图像理解，一张进货单识别约两三分钱。</p>
          <p>· 阿里百炼 <b>qwen-flash</b> 也是最便宜一档（有免费额度），把上面模型名改成 qwen-flash 即可。</p>
          <p>· 店里这点用量（一天几十次问答+几张单据），任何一档一个月通常都只要几毛到几块钱。</p>
        </div>
        <p className="text-xs text-muted-foreground">
          密钥只存在这台电脑（写盘前用系统安全存储加密），不会上传到别处；中心库模式下会推到店里自己的服务器，
          让手机端也用同一个模型。更多模型（Kimi / 豆包 / GLM / 通义）在「AI智能」页切换。
        </p>
      </CardContent>
    </Card>
  )
}
