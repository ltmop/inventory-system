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
function createHttpBackend(token: string): FiBridge {
  return {
    async invoke(channel: string, payload?: unknown) {
      let r: Response
      try {
        r = await fetch('/api/invoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-token': token },
          body: JSON.stringify({ channel, payload: payload ?? {} }),
        })
      } catch {
        throw new Error('连不上主机——检查收银电脑是不是开着、这台设备是不是连着店里 WiFi')
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
      if (!r.ok) throw new Error(data.error ?? `请求失败（${r.status}）`)
      return data.result
    },
  }
}

/** 原始桥（未包装） */
const rawBackend: FiBridge | null =
  typeof window !== 'undefined' && window.fi
    ? window.fi
    : typeof window !== 'undefined' && lanToken
      ? createHttpBackend(lanToken)
      : null

/**
 * 本地模式（原"游客"）：云账号是可选项，不登录也能全功能使用，数据只保存在本机。
 * 登录云账号仅用于多台电脑同步 + 云端备份；未登录时所有读写照常走本地/局域网通道。
 */
export const backend: FiBridge | null = rawBackend

export const backendKind: BackendKind =
  typeof window !== 'undefined' && window.fi ? 'ipc' : backend ? 'http' : null
