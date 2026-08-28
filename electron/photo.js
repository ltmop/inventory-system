// 商品图片存储：%APPDATA%/fishing-inventory/images/<productId>.<ext>
// 无 Electron 依赖、不碰 db、目录注入，可被 scripts/test-backend.mjs 直接单测。
// 三个调用方：main.js 的 photo:save/photo:delete IPC、fi-img:// 自定义协议、server.js 的 /api/photo
import fs from 'node:fs'
import path from 'node:path'

// 只放行这几种扩展名（渲染端统一压成 JPEG 传 jpg；png/webp 留给以后直接存原图的场景）
export const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'webp']
// 单张上限 8MB：渲染端按 800px/0.85 压完一般 <300KB，留足余量防异常大 base64 撑爆内存
const MAX_PHOTO_BYTES = 8 * 1024 * 1024

export function createPhotoStore(imagesDir) {
  function assertProductId(productId) {
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new Error(`非法商品 id：${productId}`)
    }
  }

  /** 该商品所有扩展名的现存图片文件（换图/删图前先清掉，避免 12.jpg 和 12.png 并存） */
  function filesOf(productId) {
    let names
    try {
      names = fs.readdirSync(imagesDir)
    } catch {
      return [] // 目录还没建（一张图都没存过）
    }
    const prefix = `${productId}.`
    return names.filter(
      (n) => n.startsWith(prefix) && PHOTO_EXTS.includes(n.slice(prefix.length).toLowerCase()),
    )
  }

  /**
   * 写图：base64 → images/<productId>.<ext>，同商品不同扩展名的旧图先清掉（换图=覆盖）。
   * 返回相对文件名（存 products.photo_path 用的就是它）。
   */
  function save(productId, base64, ext = 'jpg') {
    assertProductId(productId)
    const e = String(ext ?? '').toLowerCase()
    if (!PHOTO_EXTS.includes(e)) throw new Error(`不支持的图片格式：${ext}`)
    if (typeof base64 !== 'string' || base64 === '') throw new Error('图片数据为空')
    const buf = Buffer.from(base64, 'base64')
    if (buf.length === 0) throw new Error('图片数据不是合法 base64')
    if (buf.length > MAX_PHOTO_BYTES) {
      throw new Error(`图片超过 ${MAX_PHOTO_BYTES / 1024 / 1024}MB 上限`)
    }
    fs.mkdirSync(imagesDir, { recursive: true })
    for (const n of filesOf(productId)) fs.rmSync(path.join(imagesDir, n), { force: true })
    const fileName = `${productId}.${e}`
    fs.writeFileSync(path.join(imagesDir, fileName), buf)
    return fileName
  }

  /** 删图：清掉该商品所有扩展名的图片文件，返回删了几个（没有图也不报错） */
  function remove(productId) {
    assertProductId(productId)
    let n = 0
    for (const name of filesOf(productId)) {
      fs.rmSync(path.join(imagesDir, name), { force: true })
      n++
    }
    return n
  }

  /**
   * 相对文件名 → 绝对路径（fi-img:// 协议与手机端 /api/photo 共用的唯一入口）。
   * 只放行 images 目录内、形如 <数字>.<白名单扩展名> 的文件，防路径穿越。
   */
  function resolvePath(name) {
    if (typeof name !== 'string' || !/^\d+\.(jpg|jpeg|png|webp)$/.test(name)) return null
    const abs = path.resolve(imagesDir, name)
    if (path.dirname(abs) !== path.resolve(imagesDir)) return null // 双保险
    return abs
  }

  return { save, remove, resolvePath, filesOf }
}
