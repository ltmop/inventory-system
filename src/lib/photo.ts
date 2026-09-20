// 商品图片（渲染端）：选图 → canvas 压缩 → base64 经 photo:save IPC 落盘；
// 读图走主进程注册的 fi-img:// 自定义协议（file:// 页面直接引用 %APPDATA% 绝对路径会被拦，
// data URL 图片一多内存吃不消，故不采用）
import { backend, backendKind, getCentralConfig, lanToken } from '@/lib/api'

// 压缩参数（以后要调就改这两个）：最长边 800px、JPEG 质量 0.85
// 800px 对 48px 缩略图和弹窗大图预览都够用，一张压完一般 <300KB
const MAX_EDGE = 800
const JPEG_QUALITY = 0.85

/**
 * photo_path（images 目录里的相对文件名）→ <img> 可用地址。
 * version 用于缓存穿透（图片换了文件名没变）：传商品的 updated_at 即可。
 * mock/截图脚本注入的 data: URL 原样放行；无后端（纯浏览器 mock）返回 null 显示占位图。
 */
export function productPhotoUrl(
  photoPath: string | null | undefined,
  version?: string | number | null,
): string | null {
  if (!photoPath) return null
  if (photoPath.startsWith('data:')) return photoPath
  if (!backend) return null
  const v = version != null && version !== '' ? `&v=${encodeURIComponent(String(version))}` : ''
  // 局域网整机共享 / 中心库：图片走主机 HTTP 接口（带 token）。
  // ⚠️ 桌面端（Electron）页面是 file:// 加载的（main.js loadFile）：相对地址 `/api/photo?…`
  //    会被浏览器解析成 file:///api/photo?…，永远取不到图 —— 2026-09-21 修。
  //    所以桌面端必须用**绝对地址 + 中心库令牌**；手机看店页 / 局域网浏览器页与图片同源，
  //    仍用相对地址 + 局域网令牌（保持原行为不变）。
  if (backendKind === 'http') {
    const cfg = getCentralConfig()
    const desktop = typeof window !== 'undefined' && !!window.fi && !!cfg.url
    const base = desktop ? cfg.url.replace(/\/+$/, '') : ''
    const token = desktop ? cfg.token : (lanToken ?? '')
    return `${base}/api/photo?path=${encodeURIComponent(photoPath)}&token=${encodeURIComponent(token)}${v}`
  }
  const sep = version != null && version !== '' ? `?v=${encodeURIComponent(String(version))}` : ''
  return `fi-img://photo/${encodeURIComponent(photoPath)}${sep}`
}

/**
 * 弹系统选图框（jpg/png/webp），选好后在 canvas 上缩到最长边 800px、JPEG 0.85 压成 base64。
 * 用户取消返回 null；压缩失败抛错。
 */
export function pickCompressedPhoto(): Promise<{ base64: string; dataUrl: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/jpeg,image/png,image/webp'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      createImageBitmap(file)
        .then((bitmap) => {
          const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(bitmap.width * scale))
          canvas.height = Math.max(1, Math.round(bitmap.height * scale))
          canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
          resolve({ base64: dataUrl.split(',')[1] ?? '', dataUrl })
        })
        .catch(reject)
    }
    input.click()
  })
}

/**
 * 把压好的 JPEG base64 发给主进程写盘（images/<productId>.jpg，旧图自动清掉），
 * 返回相对文件名（调用方再经 store.updateProduct 挂到 photo_path 上）。
 * 仅 Electron 环境可用；mock 路径不该走到这里。
 */
export async function uploadProductPhoto(productId: number, base64: string): Promise<string> {
  if (!backend) throw new Error('当前环境没有后端，图片无法保存')
  const r = await backend.invoke('photo:save', { productId, base64, ext: 'jpg' })
  if (!r?.ok || !r.path) throw new Error('图片保存失败')
  return r.path as string
}

/** 删除商品图片：主进程一次做完「删文件 + 清 photo_path」，调用方负责刷新 store */
export async function deleteProductPhoto(productId: number): Promise<void> {
  if (!backend) return
  await backend.invoke('photo:delete', { productId })
}
