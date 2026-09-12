// offlineTransport.d.ts —— 给 src/lib/offlineTransport.js 的类型声明。
// 存在的意义：让 TS 侧（src/lib/api.ts）能 `import { createOffline } from './offlineTransport.js'`
// 而无需在 tsconfig 打开 allowJs。本体保持纯 JS 是为了让 scripts/A4-fixtures.mjs 能在 Node 里直接 import 它。

export interface OfflineBridge {
  invoke(channel: string, payload?: unknown): Promise<any>
  onVoiceProgress?: (cb: (p: any) => void) => () => void
  onTtsProgress?: (cb: (p: any) => void) => () => void
  onKwsProgress?: (cb: (p: any) => void) => () => void
}

export interface OfflineItem {
  id: string
  channel: string
  payload: any
  at: number
  tries: number
  failed: boolean
  err: string
  tmpId: string | null
}

export interface OfflineState { pending: number; failed: number }

export interface OfflineControl {
  /** 可直接当 FiBridge 用；inner 为 null 时这里是 null */
  bridge: OfflineBridge | null
  invoke(channel: string, payload?: unknown): Promise<any>
  pendingCount(): number
  failedCount(): number
  state(): OfflineState
  subscribe(cb: (s: OfflineState) => void): () => void
  flush(): Promise<{ done: number; left: number }>
  scheduleFlush(delay?: number): void
  queueDump(): OfflineItem[]
  idmapDump(): Record<string, unknown>
  isTmpId(v: unknown): boolean
  canQueue(channel: string): boolean
  readable(channel: string): boolean
  isNetworkError(e: unknown): boolean
  dropFailed(): number
  clearQueue(): void
  clearIdmap(): void
  clearCache(): void
}

export interface CreateOfflineOptions {
  inner: OfflineBridge | null
  storage?: Storage | { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
  now?: () => number
  online?: () => boolean
  onPending?: (pending: number, failed: number) => void
  autoFlush?: boolean
}

export declare function createOffline(opts: CreateOfflineOptions): OfflineControl
export declare function wrapOffline(inner: OfflineBridge | null, opts?: Partial<CreateOfflineOptions>): OfflineBridge | null

export declare const K_QUEUE: string
export declare const K_IDMAP: string
export declare const K_CACHE: string
export declare const CACHE_TTL: number
export declare const MAX_QUEUE: number
export declare const WRITE_CHANNELS: string[]
export declare const NO_QUEUE: Record<string, string>
export declare const NO_QUEUE_PREFIX: string[]
export declare const NO_CACHE: Record<string, number>
export declare const NO_CACHE_PREFIX: string[]
export declare const CREATE_CHANNELS: Record<string, number>
