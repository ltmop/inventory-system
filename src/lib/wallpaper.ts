import { create } from 'zustand'
import darkblue from '@/assets/svg/darkblue-hologram.svg'
import silver from '@/assets/svg/cybersilver-chrome.svg'

export interface WallpaperState { url: string | null; enabled: boolean }
export interface WallpaperOption { id: string; label: string; url: string | null }

/** 内置壁纸（大 SVG 走 Vite import，打包/Dev/中央 web 均能解析） */
export const WALLPAPER_OPTIONS: WallpaperOption[] = [
  { id: 'none', label: '无壁纸', url: null },
  { id: 'blue', label: '黑洞 · 暗夜蓝', url: darkblue },
  { id: 'silver', label: '铬立方 · 赛博银', url: silver },
]

const KEY = 'fi-wallpaper'
function load(): WallpaperState {
  try {
    const s = window.localStorage.getItem(KEY)
    if (s) return JSON.parse(s)
  } catch {}
  return { url: null, enabled: false }
}

export const useWallpaper = create<WallpaperState & { setWallpaper: (w: Partial<WallpaperState>) => void }>(
  (set, get) => ({
    ...load(),
    setWallpaper: (w) => {
      set((s) => ({ ...s, ...w }))
      try { window.localStorage.setItem(KEY, JSON.stringify(get())) } catch {}
    },
  }),
)
