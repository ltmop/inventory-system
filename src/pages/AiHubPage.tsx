// AI智能（通用版 6 大导航之一）：AI 助手 / 语音模型 / 拍照识别额度
import { useEffect, useState } from 'react'
import { Sparkles, Mic, AudioLines } from 'lucide-react'
import { PageHeading } from '@/components/layout/FeatureGrid'
import { backend } from '@/lib/api'
import { readWakeEnabled, writeWakeEnabled, startWakeListener, stopWakeListener } from '@/lib/wakeWord'
import { useVoiceModel, useTtsModel, useKwsModel } from '@/lib/useModelDownload'
import { useOnline } from '@/lib/useOnline'
import { AiAssistantCard } from './settings/AiAssistantCard'
import { AiQuotaCard } from './settings/AiQuotaCard'
import { GatewayQuotaCard } from './settings/GatewayQuotaCard'
import { ModelDownloadCard } from './settings/ModelDownloadCard'
import { WakeWordCard } from './settings/WakeWordCard'

export default function AiHubPage() {
  const online = useOnline()

  // AI 助手（多模型提供商：Kimi/豆包/GLM/通义，可切换主力模型）
  const [aiConfigured, setAiConfigured] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMessage, setAiMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [providers, setProviders] = useState<{ key: string; name: string; model: string; keyPage: string; configured: boolean; official?: boolean }[]>([])
  const [currentProvider, setCurrentProvider] = useState('kimi')
  // 自定义 API 地址 / 模型（接入自建或中转的 DeepSeek 等）
  const [endpointInput, setEndpointInput] = useState('')
  const [modelInput, setModelInput] = useState('')

  // 语音识别模型状态（本地 sherpa-onnx 离线识别）
  const voice = useVoiceModel()
  // 语音合成模型状态（本地 sherpa-onnx 离线播报）
  const ttsModel = useTtsModel()
  // 唤醒词模型状态 + 实验性常驻监听开关（默认关，开启才申请麦克风常驻权限）
  const kws = useKwsModel()
  const [wakeOn, setWakeOn] = useState(readWakeEnabled)
  const [wakeError, setWakeError] = useState<string | null>(null)
  const toggleWake = async () => {
    const next = !wakeOn
    setWakeError(null)
    if (!next) {
      writeWakeEnabled(false)
      stopWakeListener()
      setWakeOn(false)
      return
    }
    const r = await startWakeListener()
    if (r.ok) {
      writeWakeEnabled(true)
      setWakeOn(true)
    } else {
      setWakeError(r.reason ?? '唤醒词监听开启失败')
    }
  }

  useEffect(() => {
    if (backend) {
      backend.invoke('ai:status')
        .then((s) => { setAiConfigured(!!s?.configured); if (s?.providerKey) setCurrentProvider(s.providerKey) })
        .catch(() => {})
      backend.invoke('ai:providers').then(setProviders).catch(() => {})
    }
  }, [])

  /** 把配置同步到中心库：手机端「小渔」用同一份配置（不是中心库模式就如实说明） */
  const syncToCentral = async (): Promise<string> => {
    if (!backend) return ''
    try {
      const s = await backend.invoke('ai:syncCentral')
      if (s?.ok) return ' 已同步到中心库，手机端「小渔」也用这个模型。'
      if (s?.reason === 'not-central') return ' （本机模式，手机端仍走官方 AI 服务）'
      return ` 同步到手机端失败（${s?.reason ?? '未知原因'}）。`
    } catch { return '' }
  }

  const handleSaveKey = async () => {
    if (!backend) return
    setAiBusy(true)
    setAiMessage(null)
    try {
      // 地址/模型一起保存（填了才覆盖，留空用默认）
      if (endpointInput.trim() || modelInput.trim()) {
        await backend.invoke('ai:setEndpoint', { provider: currentProvider, baseUrl: endpointInput.trim(), model: modelInput.trim() })
      }
      await backend.invoke('ai:setKey', { key: keyInput })
      const t = await backend.invoke('ai:test')
      if (t?.ok) {
        setAiConfigured(true)
        setKeyInput('')
        const note = await syncToCentral()
        const fresh = await backend.invoke('ai:providers').catch(() => null)
        if (fresh) setProviders(fresh)
        setAiMessage({ ok: true, text: '验证通过，AI 助手已激活。仪表盘今日经营小结会自动生成 AI 打烊日报。' + note })
      } else {
        setAiMessage({ ok: false, text: `Key 已保存但验证失败（${t?.reason ?? '未知原因'}），请检查 API 地址、Key 是否正确、账户是否有余额` })
      }
    } catch (e) {
      setAiMessage({ ok: false, text: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setAiBusy(false)
    }
  }

  /** 只保存 API 地址 / 模型（不改 Key） */
  const handleSaveEndpoint = async () => {
    if (!backend) return
    setAiBusy(true)
    setAiMessage(null)
    try {
      const s = await backend.invoke('ai:setEndpoint', { provider: currentProvider, baseUrl: endpointInput.trim(), model: modelInput.trim() })
      const fresh = await backend.invoke('ai:providers').catch(() => null)
      if (fresh) setProviders(fresh)
      setEndpointInput('')
      setModelInput('')
      setAiMessage({ ok: true, text: `已保存：${s?.baseUrl ?? ''} · ${s?.model ?? ''}。现在点「保存并验证」填 Key 就能用。` })
    } catch (e) {
      setAiMessage({ ok: false, text: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setAiBusy(false)
    }
  }

  const handleClearKey = async () => {
    if (!backend) return
    await backend.invoke('ai:clearKey').catch(() => {})
    setAiConfigured(false)
    setAiMessage({ ok: true, text: '已停用 AI 助手，Key 已从本机删除' })
  }

  // 切换主力 AI 模型提供商
  const handleProviderChange = async (provider: string) => {
    if (!backend || provider === currentProvider) return
    setAiBusy(true)
    setAiMessage(null)
    try {
      const s = await backend.invoke('ai:setProvider', { provider })
      setCurrentProvider(provider)
      setAiConfigured(!!s?.configured)
      setKeyInput('')
      setAiMessage({ ok: true, text: `已切换到 ${providers.find((p) => p.key === provider)?.name ?? provider}。` + (s?.configured ? ' 该模型已配好 Key，可以直接用。' : ' 需要先填这个模型的 API Key。') })
    } catch (e) {
      setAiMessage({ ok: false, text: e instanceof Error ? e.message : '切换失败' })
    } finally {
      setAiBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeading title="AI智能" desc="AI 助手问答、拍照识别、语音输入与离线语音模型" icon={Sparkles} />

      {/* AI 助手（多模型提供商） */}
      <AiAssistantCard
        hasBackend={!!backend}
        aiConfigured={aiConfigured}
        keyInput={keyInput}
        onKeyInputChange={setKeyInput}
        aiBusy={aiBusy}
        aiMessage={aiMessage}
        online={online}
        providers={providers}
        currentProvider={currentProvider}
        onProviderChange={(p) => void handleProviderChange(p)}
        onSaveKey={handleSaveKey}
        onClearKey={handleClearKey}
        endpointInput={endpointInput}
        onEndpointInputChange={setEndpointInput}
        modelInput={modelInput}
        onModelInputChange={setModelInput}
        onSaveEndpoint={() => void handleSaveEndpoint()}
        onOpenExternal={(url) => void backend?.invoke('app:openExternal', url)}
      />

      {/* AI 视觉识别额度（v3.0） */}
      <AiQuotaCard />

      {/* 官方 AI 额度（P0 计费阀门）：余额/流水/充值/补绑激活码 */}
      <GatewayQuotaCard />

      {/* 语音识别模型（本地离线识别，阿里 SenseVoiceSmall 约228MB） */}
      <ModelDownloadCard
        icon={<Mic className="size-5 text-brand-500" />}
        title="语音识别模型"
        description={'AI 助手"按住说话"用的识别模型（阿里 SenseVoice），下载后完全离线识别，没网也能用，中文识别准，说话内容不出本机。'}
        model={voice}
        readyText="模型已就绪（约228MB），按住说话走本地离线识别。"
        downloadLabel="下载模型（约228MB）"
        notReadyHint="未下载：按住说话暂时走在线识别，下载后自动切换为离线识别"
        hasBackend={!!backend}
        online={online}
      />

      {/* 语音合成模型（本地离线播报） */}
      <ModelDownloadCard
        icon={<AudioLines className="size-5 text-brand-500" />}
        title="语音合成模型"
        description={'AI 助手"语音播报"用的合成模型，下载后完全离线合成，没网也能播报，比系统自带语音更自然。'}
        model={ttsModel}
        readyText="模型已就绪（约42MB），语音播报走本地离线合成。"
        downloadLabel="下载模型（约42MB）"
        notReadyHint="未下载：语音播报暂时用系统自带语音，下载后自动切换为离线合成"
        hasBackend={!!backend}
        online={online}
      />

      {/* 唤醒词监听（实验，默认关闭） */}
      <WakeWordCard
        kws={kws}
        wakeOn={wakeOn}
        wakeError={wakeError}
        onToggleWake={() => void toggleWake()}
        hasBackend={!!backend}
        online={online}
      />
    </div>
  )
}
