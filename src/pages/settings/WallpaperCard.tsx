import { useRef } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import { useWallpaper, WALLPAPER_OPTIONS } from '@/lib/wallpaper'
import { cn } from '@/lib/utils'

/** 桌面壁纸：选内置 SVG / 上传自定义 SVG（自动渲染为 app 背景，太大用 cover 缩放铺满，压暗层不遮功能）。 */
export function WallpaperCard() {
  const wp = useWallpaper()
  const fileRef = useRef<HTMLInputElement>(null)

  function apply(id: string) {
    const opt = WALLPAPER_OPTIONS.find((o) => o.id === id) ?? WALLPAPER_OPTIONS[0]
    if (opt.url) useWallpaper.getState().setWallpaper({ url: opt.url, enabled: true })
    else useWallpaper.getState().setWallpaper({ enabled: false, url: null })
  }

  function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      useWallpaper.getState().setWallpaper({ url, enabled: true })
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const currentId = WALLPAPER_OPTIONS.find((o) => o.url === wp.url)?.id ?? 'none'

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
        <ImagePlus className="size-4 text-brand-600" />
        桌面壁纸
        <span className="ml-auto text-xs font-normal text-slate-400">SVG 背景 · cover 缩放 · 压暗层不遮功能</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {WALLPAPER_OPTIONS.map((o) => (
          <button
            key={o.id}
            onClick={() => apply(o.id)}
            className={cn(
              'cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors',
              currentId === o.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5',
            )}
          >
            {o.label}
          </button>
        ))}
        <button
          onClick={() => fileRef.current?.click()}
          className="cursor-pointer rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5"
        >
          + 上传自定义 SVG
        </button>
        <input ref={fileRef} type="file" accept=".svg,image/svg+xml" className="hidden" onChange={onUpload} />
        {wp.enabled && wp.url && (
          <button
            onClick={() => useWallpaper.getState().setWallpaper({ enabled: false })}
            className="flex cursor-pointer items-center gap-1 text-xs text-slate-500 hover:text-red-600"
          >
            <Trash2 className="size-3.5" /> 关闭壁纸
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-400">
        SVG 作为全屏背景自动渲染；太大时按 cover 缩放铺满，并叠加半透明压暗层保证数据清晰、不遮挡功能模块。
      </p>
      {wp.enabled && wp.url && (
        <div
          className="mt-3 h-20 rounded-lg border border-slate-100 bg-cover bg-center dark:border-white/10"
          style={{ backgroundImage: 'url("' + wp.url + '")' }}
        />
      )}
    </div>
  )
}
