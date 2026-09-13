import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 行为级回归：**中心库模式下，纯本机通道必须走本机 IPC，业务通道照旧走 HTTP**。
 *
 * 为什么必须有这个测试（2026-09-14 真机取证）：
 *   老板的收银机在中心库模式（localStorage `fi-central-url=https://app.junchengzn.com`），
 *   而 api.ts 曾把**所有**通道都发给中心库，中心库没有 cloud:/update: 系列通道 → unknown channel
 *   → 渲染层静默吞掉 → 「已登录却显示未登录」+「点下载更新没反应」。
 *   纯源码 grep 只能证明"代码长这样"，证明不了"运行时真的分路"——所以这里桩掉 window.fi
 *   与 fetch，直接断言每个通道最终打到了哪一边。
 *
 * api.ts 在**模块加载时**就读 localStorage 决定后端（`const central = getCentralConfig()`），
 * 所以每个用例都必须：先铺环境 → vi.resetModules() → 再动态 import。
 */

type Stub = {
  ipcCalls: string[]
  fetchCalls: string[]
  mod: typeof import('./api')
}

async function loadApi(opts: { centralUrl?: string; withFi?: boolean }): Promise<Stub> {
  const store = new Map<string, string>()
  if (opts.centralUrl) {
    store.set('fi-central-url', opts.centralUrl)
    store.set('fi-central-token', 'tok-central')
  }
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }

  const ipcCalls: string[] = []
  const fi = opts.withFi
    ? {
        invoke: async (channel: string) => {
          ipcCalls.push(channel)
          return { viaIpc: channel }
        },
      }
    : undefined

  // Node 26 里 navigator 是只读 getter，直接赋值会抛 TypeError → 统一用 defineProperty
  const def = (k: string, v: unknown) =>
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  def('localStorage', ls)
  def('window', { fi, localStorage: ls, location: { search: '' } })
  def('navigator', { onLine: true })

  const fetchCalls: string[] = []
  def('fetch', async (_url: string, init?: { body?: string }) => {
    let channel = ''
    try {
      channel = JSON.parse(init?.body ?? '{}').channel ?? ''
    } catch {
      /* ignore */
    }
    fetchCalls.push(channel)
    return {
      status: 200,
      ok: true,
      json: async () => ({ result: { viaHttp: channel } }),
    }
  })

  vi.resetModules()
  const mod = (await import('./api')) as typeof import('./api')
  return { ipcCalls, fetchCalls, mod }
}

describe('中心库模式下本机通道的分路', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('cloud:status 走本机 IPC，不发 HTTP（这是「已登录却显示未登录」的根因）', async () => {
    const { mod, ipcCalls, fetchCalls } = await loadApi({
      centralUrl: 'https://app.junchengzn.com',
      withFi: true,
    })
    const r = await mod.backend!.invoke('cloud:status')
    expect(ipcCalls).toEqual(['cloud:status'])
    expect(fetchCalls).toEqual([])
    expect(r).toEqual({ viaIpc: 'cloud:status' })
  })

  it('update:downloadAndInstall 走本机 IPC（这是「点更新没反应」的根因）', async () => {
    const { mod, ipcCalls, fetchCalls } = await loadApi({
      centralUrl: 'https://app.junchengzn.com',
      withFi: true,
    })
    await mod.backend!.invoke('update:downloadAndInstall')
    expect(ipcCalls).toEqual(['update:downloadAndInstall'])
    expect(fetchCalls).toEqual([])
  })

  it('业务通道照旧走中心库 HTTP，不能被误拦', async () => {
    const { mod, ipcCalls, fetchCalls } = await loadApi({
      centralUrl: 'https://app.junchengzn.com',
      withFi: true,
    })
    const r = await mod.backend!.invoke('data:loadAll')
    expect(fetchCalls).toEqual(['data:loadAll'])
    expect(ipcCalls).toEqual([])
    expect(r).toEqual({ viaHttp: 'data:loadAll' })
  })

  it('本机通道不过离线层：连打两次都真的到了 IPC，没有第二次被缓存截走', async () => {
    const { mod, ipcCalls, fetchCalls } = await loadApi({
      centralUrl: 'https://app.junchengzn.com',
      withFi: true,
    })
    await mod.backend!.invoke('cloud:status')
    await mod.backend!.invoke('cloud:status')
    expect(ipcCalls).toEqual(['cloud:status', 'cloud:status'])
    expect(fetchCalls).toEqual([])
  })

  it('没有 window.fi（手机浏览器）时行为不变：仍然发 HTTP', async () => {
    const { mod, ipcCalls, fetchCalls } = await loadApi({
      centralUrl: 'https://app.junchengzn.com',
      withFi: false,
    })
    await mod.backend!.invoke('cloud:status')
    expect(ipcCalls).toEqual([])
    expect(fetchCalls).toEqual(['cloud:status'])
  })

  it('不在中心库模式（纯 IPC）时，一切仍走本机 IPC', async () => {
    const { mod, ipcCalls, fetchCalls } = await loadApi({ withFi: true })
    await mod.backend!.invoke('cloud:status')
    await mod.backend!.invoke('data:loadAll')
    expect(ipcCalls).toEqual(['cloud:status', 'data:loadAll'])
    expect(fetchCalls).toEqual([])
  })
})

describe('isLocalOnlyChannel', () => {
  it('认 cloud: / update: 前缀', async () => {
    const { mod } = await loadApi({ withFi: true })
    expect(mod.isLocalOnlyChannel('cloud:status')).toBe(true)
    expect(mod.isLocalOnlyChannel('cloud:centralConfig')).toBe(true)
    expect(mod.isLocalOnlyChannel('update:check')).toBe(true)
    expect(mod.isLocalOnlyChannel('update:downloadAndInstall')).toBe(true)
  })

  it('不误伤业务通道', async () => {
    const { mod } = await loadApi({ withFi: true })
    for (const ch of ['data:loadAll', 'product:create', 'outbound:confirm', 'category:setParent']) {
      expect(mod.isLocalOnlyChannel(ch)).toBe(false)
    }
  })
})
