import { createOffline } from './offlineTransport.js'

// 本地模式（原"游客"）：云账号可选，不登录也全功能使用；guest 标记仅用于界面横幅提示
const GUEST_KEY = 'fi-cloud-guest'
/** 当前是否游客模式（跳过登录） */
export function isGuestMode(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(GUEST_KEY) === '1'
  } catch {
    return false
  }
}
export function setGuestMode(v: boolean): void {
  try {
    if (v) window.localStorage.setItem(GUEST_KEY, '1')
    else window.localStorage.removeItem(GUEST_KEY)
  } catch { /* ignore */ }
}

// 后端桥：三种运行形态
// 1. Electron 桌面端：preload 暴露 window.fi 走 IPC（kind='ipc'）
// 2. 局域网整机共享：其他电脑/平板浏览器打开主机 /app 页面，走 HTTP /api/invoke（kind='http'）
// 3. 纯浏览器 dev（npm run dev，没给 token）：backend 为 null，store 回退本地 mock 逻辑
export interface VoiceProgress {
  file: string
  received: number
  total: number
  percent: number
}

export interface FiBridge {
  invoke(channel: string, payload?: unknown): Promise<any>
  /** 订阅语音模型下载进度，返回取消订阅函数（preload 暴露，浏览器 dev 模式没有） */
  onVoiceProgress?(callback: (p: VoiceProgress) => void): () => void
  /** 订阅语音合成模型下载进度 */
  onTtsProgress?(callback: (p: VoiceProgress) => void): () => void
  /** 订阅唤醒词模型下载进度 */
  onKwsProgress?(callback: (p: VoiceProgress) => void): () => void
}

export type BackendKind = 'ipc' | 'http' | null

declare global {
  interface Window {
    fi?: FiBridge
  }
}

const TOKEN_KEY = 'fi-lan-token'

/** 局域网访问令牌：网址 ?token= 带来一次，之后从 localStorage 取（换台设备要重新用主机上的链接打开） */
export const lanToken: string | null = (() => {
  if (typeof window === 'undefined') return null
  const fromUrl = new URLSearchParams(window.location.search).get('token')
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl)
    } catch {
      // 隐私模式写不进也没关系，本次会话 URL 里的还能用
    }
    return fromUrl
  }
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
})()

/** 局域网 HTTP 桥：与 window.fi 同一 invoke(channel, payload) 形状，store 层零改动 */
function createHttpBackend(token: string, baseUrl = ''): FiBridge {
  const url = (baseUrl ? baseUrl.replace(/\/$/, '') : '') + '/api/invoke'
  const label = baseUrl ? '中心库' : '主机'
  return {
    async invoke(channel: string, payload?: unknown) {
      let r: Response
      // 稳定性（P3）：短暂断网/抖动自动重试，最多 3 次指数退避，避免一次掉线就中断操作
      for (let attempt = 0; ; attempt++) {
        try {
          r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-token': token },
            body: JSON.stringify({ channel, payload: payload ?? {} }),
          })
          break
        } catch {
          if (attempt >= 2) {
            // A3 离线层：打上 network 标记，供离线传输层精确区分「网络故障」与「业务拒绝」
            const err = new Error('连不上' + label + '——检查网络是否连接、' + label + '是否在线，稍后重试；已自动重试 3 次')
            ;(err as Error & { network?: boolean }).network = true
            throw err
          }
          await new Promise((res) => setTimeout(res, 700 * (attempt + 1)))
        }
      }
      const data = await r.json().catch(() => ({}))
      if (r.status === 401) {
        try {
          localStorage.removeItem(TOKEN_KEY)
        } catch {
          // 忽略
        }
        throw new Error('链接已失效——到收银电脑的「设置 → 手机看店」重新复制网址打开')
      }
      if (!r.ok) {
        // A3 离线层：带上 HTTP 状态码 → 离线层据此判定「业务拒绝，绝不入队」
        // ⚠️ 「unknown channel」必须翻译：中心库模式下把"问本机"的通道发过去就是这句，
        //    原文对店老板毫无意义，而它恰恰是「点了没反应」那一大类问题的真正原因。
        const err = new Error(friendlyChannelError(channel, data.error ?? `请求失败（${r.status}）`))
        ;(err as Error & { status?: number }).status = r.status
        throw err
      }
      return data.result
    },
  }
}

// 中心库模式（P2：桌面软件连云端）——设置里配了「连接云端中心库」的 URL+token, 桌面版也走 http-backend 连它（覆盖本地 IPC），读写全走中心库（多点实时共享）

/**
 * 把服务器返回的错误原文翻译成用户能懂的话。
 * 目前只翻译一种，但它是最常见、也最难自己看懂的一种：
 *   中心库模式下，凡是"问本机"的通道（app:/server:/license:/feedback:/payment 的收款码…）
 *   打到中心库，server.js 一律回 404 `unknown channel`。
 * 原文照给 = 用户看到一句英文，然后以为"软件坏了"。
 */
export function friendlyChannelError(channel: string, raw: string): string {
  if (/unknown channel/i.test(raw)) {
    return `「${channel}」这个功能在中心库模式下还没开通：本机有、中心库那台服务器上没有。请先用「断开中心库」回到本机模式，或把它加进本机通道表（见 docs/中心库模式-通道缺口清单.md）`
  }
  return raw
}
const CENTRAL_URL_KEY = 'fi-central-url'
const CENTRAL_TOKEN_KEY = 'fi-central-token'
export function getCentralConfig(): { url: string; token: string } {
  try {
    return { url: localStorage.getItem(CENTRAL_URL_KEY) ?? '', token: localStorage.getItem(CENTRAL_TOKEN_KEY) ?? '' }
  } catch { return { url: '', token: '' } }
}
export function setCentralConfig(url: string, token: string) {
  try {
    if (url && token) { localStorage.setItem(CENTRAL_URL_KEY, url); localStorage.setItem(CENTRAL_TOKEN_KEY, token) }
    else { localStorage.removeItem(CENTRAL_URL_KEY); localStorage.removeItem(CENTRAL_TOKEN_KEY) }
  } catch { /* ignore */ }
  // 换中心库模式必须立刻告诉主进程（它决定要不要禁止整库上传），否则要等下次启动才生效
  reportCentralModeToMain()
}

/**
 * 把「本机是不是中心库模式」上报给主进程。
 *
 * 为什么主进程需要知道（方案A，2026-09-14 owner 拍板）：
 *   配置存在 localStorage，主进程看不见；而主进程手里有两条会把**本机 data.db** 整库推上云的通道
 *   （整库快照 → 手机看板、每日整库备份）。中心库模式下本机库不是权威账本、还会越用越旧，
 *   推上去就是拿过期库覆盖云端。所以中心库模式一开，主进程必须停掉这两条。
 *   读的是 getCentralConfig()（写盘后的真值），不是入参 —— 写失败时不谎报。
 * 失败一律吞掉：这只是个安全开关，不该影响界面任何操作（手机浏览器里没有 window.fi，直接跳过）。
 */
export function reportCentralModeToMain(cfg: { url: string; token: string } = getCentralConfig()) {
  const local = localBridge()
  if (!local) return
  try {
    void Promise.resolve(local.invoke('cloud:setCentralMode', { on: !!cfg.url && !!cfg.token })).catch(() => {})
  } catch { /* ignore */ }
}

/**
 * 用系统浏览器打开外链（官网、说明书…）。
 *
 * ⚠️ 三个坑，都踩过：
 *   ① 渲染层 `window.open` 会被 main 的 `setWindowOpenHandler(() => ({ action: 'deny' }))` **一律拒掉**
 *      —— 点了等于没反应（owner 反馈的「官网未链接」）。正确出口是 main 的 `app:openExternal`。
 *   ② 该通道必须走本机：已加进 LOCAL_ONLY_CHANNELS，否则中心库模式下又会打到服务器上。
 *   ③ 打不开时**绝不能** `window.location.href = url` 兜底 —— 那会把整个应用窗口导航到外站，回不来
 *      （HelpPage 原来是这么写的）。只退回"让用户自己复制地址"。
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!url) return false
  const local = localBridge()
  if (!local) {
    try { window.prompt('复制这个地址到浏览器打开：', url) } catch { /* ignore */ }
    return false
  }
  try {
    await local.invoke('app:openExternal', url)
    return true
  } catch {
    try { window.prompt('没能自动打开浏览器，复制这个地址手动打开：', url) } catch { /* ignore */ }
    return false
  }
}
const central = getCentralConfig()

/**
 * 「纯本机通道」：问的是**这台电脑自己**的状态 —— 中心库/主机上没有、也不该有这些通道。
 *
 * 为什么必须单独挑出来（2026-09-14 真机取证）：
 *   老板的收银机跑在**中心库模式**（localStorage `fi-central-url=https://app.junchengzn.com`，
 *   运行中的进程有两条到 43.128.20.39:443 的 ESTABLISHED 连接），此时下面 `rawBackend`
 *   会把**所有**通道都发给中心库。于是：
 *     · `cloud:status` → 中心库没实现这个通道 → 返回 "unknown channel"
 *       → Layout 的 `.catch(() => {})` 吞掉 → `cloud.paired` 恒为 false
 *       → **右上角永远显示「未登录」**，哪怕本机云账号是登着的 → owner 反馈的症状②
 *     · `update:downloadAndInstall` → 同样未知通道 → UpdateBanner 的 catch 吞掉
 *       → **点「下载更新」毫无反应** → owner 反馈的症状①
 *   两者都不是"服务器坏了"，而是**把"问本机"的问题发给了别人**。
 *   已 `grep` 证实 `electron/server.js` 的 INVOKE_CHANNELS 里确实没有 `cloud:` / `update:` 系列。
 *
 * 所以：桌面端（有 `window.fi`）遇到这些前缀一律走本机 IPC；
 * 手机浏览器等没有 `window.fi` 的客户端行为完全不变（本来也没有"本机"这个概念）。
 */
export const LOCAL_ONLY_PREFIXES = ['cloud:', 'update:', 'site:'] as const

/**
 * 精确到**通道名**的本机通道（只按前缀不够用 —— 会误伤同前缀的业务通道）。
 *
 * 为什么不能只按前缀分：`payment:record` 是**记账**（业务，必须打到中心库），
 * 而 `payment:getQr/saveQr/deleteQr` 读写的是**这台电脑上的图片文件**（手机端由本机局域网服务读同一份）。
 * 同前缀下两种东西，只能逐个点名。
 *
 * 2026-09-14 owner 反馈「设置里一堆功能不能用」的真根因：
 *   中心库模式下 rawBackend 把所有非本机通道都发给中心库，而**中心库上没有这些通道**
 *   （server.js 的 INVOKE_CHANNELS 里没有 app: / server: / license: / feedback: 等）→
 *   HTTP 404 `unknown channel` → 渲染层 .catch 一吞 → 用户看到的就是「点了没反应」。
 *   实测这类通道共 62 个（见 docs/中心库模式-通道缺口清单.md），下面是**答案只可能来自这台电脑**的那部分。
 *
 * 判定标准一条就够：**这个通道的答案，中心库那台服务器上有没有？**
 *   没有 → 本机（加到这里）；有 → 仍走中心库，别加（哪怕语义上看起来重复）。
 */
export const LOCAL_ONLY_CHANNELS = [
  // 关于「这台电脑 / 这个软件本身」
  'app:info',                 // 本机数据库与备份目录、最近备份时间
  'app:openExternal',         // 打开本机浏览器（渲染层 window.open 已被 main 的 setWindowOpenHandler 拒掉）
  'server:status',            // 本机局域网看店服务的运行状态/端口/token
  'server:toggle',
  'server:regenerateToken',
  // 授权绑的是本机机器码
  'license:status',
  'license:activate',
  'ai:bindLicense',
  // 反馈是从这台电脑发出去的
  'feedback:send',
  // 本机硬件：麦克风/扬声器只长在这台电脑上
  'tts:speak',
  'tts:status',
  'kws:push',
  'kws:status',
  'voice:parseOrder',
  // 本机文件：收款码图片（中心库上那份即使存在，也和这台电脑柜台贴的不是同一张）
  'payment:getQr',
  'payment:saveQr',
  'payment:deleteQr',
  // 本机磁盘：备份/恢复的都是这台电脑 data 目录里的文件
  // ⚠️ 不含 backup:list —— 那一个**故意**留在服务端：CloudCard 只在实际连了中心库时才调它，
  //    列的是「中心库服务端每日备份」（见 CloudCard.handleListBackups）。服务端有、本机没有。
  'backup:now',
  'backup:status',
  'backup:restore',
  'backup:setExtraDir',
  'backup:clearExtraDir',
  // 本机首次引导状态（写本机 settings 的 fi-onboarded）
  'onboarding:status',
  'onboarding:finish',
  'onboarding:reset',
  // 本机 AI 配置与用量（不读账本；带账本语义的 ai: 通道见缺口清单，不能本机化）
  'ai:setKey',
  'ai:clearKey',
  'ai:providers',
  'ai:setProvider',
  'ai:test',
  'ai:quota',
  'ai:gatewayQuota',
  'ai:localUsageStats',
  'ai:history',
  // 命令台：命令在本机执行
  'commands:list',
  'commands:invoke',
] as const

export function isLocalOnlyChannel(channel: string): boolean {
  return (
    LOCAL_ONLY_PREFIXES.some((p) => channel.indexOf(p) === 0) ||
    (LOCAL_ONLY_CHANNELS as readonly string[]).includes(channel)
  )
}

/** 本机 IPC 桥（只有 Electron 里有）；手机浏览器 / 纯网页为 null */
function localBridge(): FiBridge | null {
  return typeof window !== 'undefined' && window.fi ? window.fi : null
}

/** 原始桥（未包装）：优先中心库模式，其次本地 IPC（Electron），再局域网 http */
const rawBackend: FiBridge | null =
  typeof window !== 'undefined' && central.url && central.token
    ? createHttpBackend(central.token, central.url)
    : typeof window !== 'undefined' && window.fi
      ? window.fi
      : typeof window !== 'undefined' && lanToken
        ? createHttpBackend(lanToken)
        : null

/**
 * 本地模式（原"游客"）：云账号是可选项，不登录也能全功能使用，数据只保存在本机。
 * 登录云账号仅用于多台电脑同步 + 云端备份；未登录时所有读写照常走本地/局域网通道。
 */
// A3 离线层：只在传输层包住 rawBackend 这一个导出点 → 所有调用方零改动白得
// 「断网写队列 + 断网读缓存 + 联网幂等重放」。队列是传输缓冲，不是账本，不产生任何本地单据。
const offlineApi = createOffline({ inner: rawBackend })

/** 离线层控制面：队列长度/失败数/订阅/手动重传。UI 横幅与「待上传」面板从这里接线。 */
export const offline = offlineApi

const offlineBridge = offlineApi.bridge as FiBridge | null

/**
 * 对外**唯一**后端出口。
 *
 * 纯本机通道（`cloud:` / `update:`）→ 直连本机 IPC，**且不经离线层**：
 *   离线层会给"读"加 7 天缓存、给"写"排队 —— 而
 *     · 「本机登录态」被缓存，会把一次 `paired:false` 钉死 7 天（即使后端已恢复也读到旧值）；
 *     · 「下载更新」被排队，会让用户以为点成功了，其实一个字节都没下。
 *   所以这两类必须绕开离线层。已同时把它们加进 offlineTransport 的 NO_CACHE_PREFIX 作为双保险。
 */
export const backend: FiBridge | null = offlineBridge
  ? ({
      invoke(channel: string, payload?: unknown) {
        const local = localBridge()
        if (local && isLocalOnlyChannel(channel)) return local.invoke(channel, payload)
        return offlineBridge.invoke(channel, payload)
      },
    } as FiBridge)
  : null

export const backendKind: BackendKind =
  typeof window !== 'undefined' && window.fi && !central.url ? 'ipc' : backend ? 'http' : null
