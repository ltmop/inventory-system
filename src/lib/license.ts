import { useAppStore } from '@/store/appStore'
import { backend } from '@/lib/api'
import { useEffect } from 'react'

export type LicenseLevel = 'free' | 'pro' | 'max'

/** 版本名称映射（v3.0） */
export const LEVEL_NAMES: Record<LicenseLevel, string> = {
  free: '普通版',
  pro: '进阶版',
  max: '大师版',
}

/** 版本 SKU/店/人 上限展示（与后端 license.js VERSION_PLAN 一致） */
export const LEVEL_PLANS: Record<LicenseLevel, { label: string; sku: string; stores: string; users: string }> = {
  free: { label: '普通版', sku: '300', stores: '1 店', users: '2 人' },
  pro: { label: '进阶版', sku: '1000', stores: '3 店', users: '10 人' },
  max: { label: '大师版', sku: '无限', stores: '无限', users: '无限' },
}

export interface LicenseState {
  activated: boolean
  level: LicenseLevel
  expiresAt: string | null
  machineId: string
  daysLeft: number | null
}

/** 前端授权 hook：Electron 走 IPC，浏览器 mock 默认免费 */
export function useLicense(): LicenseState & {
  activate: (code: string) => Promise<{ ok: boolean; error?: string }>
  isPaid: boolean
} {
  const license = useAppStore((s) => s.license)
  const setLicense = useAppStore((s) => s.setLicense)

  useEffect(() => {
    if (!backend) return
    backend.invoke('license:status').then((s) => {
      if (s) setLicense(s)
    }).catch(() => {})
  }, [setLicense])

  const activate = async (code: string) => {
    if (!backend) return { ok: false, error: '仅在桌面端支持激活' }
    try {
      const r = await backend.invoke('license:activate', { code })
      if (r?.ok) {
        setLicense(r.license)
        return { ok: true }
      }
      return { ok: false, error: r?.error || '激活失败' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    ...license,
    activate,
    isPaid: license.activated && license.level !== 'free' && license.daysLeft !== null && license.daysLeft > 0,
  }
}

/** 格式化剩余天数 */
export function daysText(daysLeft: number | null): string {
  if (daysLeft === null) return '未激活'
  if (daysLeft <= 0) return '已到期，请续费'
  if (daysLeft > 365 * 50) return '永久有效'
  if (daysLeft > 365) return `剩余 ${Math.floor(daysLeft / 365)} 年 ${daysLeft % 365} 天`
  return `剩余 ${daysLeft} 天`
}
