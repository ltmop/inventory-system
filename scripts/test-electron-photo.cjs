// 商品图片 Electron 实跑验证：photo:save 落盘 → photo_path 挂商品 → fi-img:// 协议读图 → photo:delete 清理
// 用商品 #1 做链路验证，结束时删图并清 photo_path，不留痕迹
const { _electron: electron } = require('playwright')
const fs = require('fs')
const path = require('path')

;(async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await win.waitForLoadState('load')
  await win.waitForTimeout(2000)

  const imagesDir = path.join(process.env.APPDATA, 'fishing-inventory', 'images')

  // 页面里 canvas 画一张图 → JPEG base64（与真实选图压缩同一路径的产物）
  const base64 = await win.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 120
    c.height = 90
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#1d4ed8'
    ctx.fillRect(0, 0, 120, 90)
    ctx.fillStyle = '#fff'
    ctx.font = '20px sans-serif'
    ctx.fillText('测试图', 30, 50)
    return c.toDataURL('image/jpeg', 0.85).split(',')[1]
  })

  // photo:save 落盘 + product:update 挂 photo_path
  const saved = await win.evaluate(
    ({ productId, base64 }) => window.fi.invoke('photo:save', { productId, base64, ext: 'jpg' }),
    { productId: 1, base64 },
  )
  console.log('photo:save →', JSON.stringify(saved))
  if (!saved?.ok || saved.path !== '1.jpg') throw new Error('photo:save 返回不对')
  if (!fs.existsSync(path.join(imagesDir, '1.jpg'))) throw new Error('图片文件没落盘')
  console.log('图片文件落盘: OK', path.join(imagesDir, '1.jpg'))

  await win.evaluate(() => window.fi.invoke('product:update', { id: 1, photo_path: '1.jpg' }))

  // fi-img:// 协议读图：能加载出真实像素才算通
  const imgOk = await win.evaluate(
    (url) =>
      new Promise((resolve) => {
        const img = new Image()
        img.onload = () => resolve(img.naturalWidth === 120)
        img.onerror = () => resolve(false)
        img.src = url
      }),
    'fi-img://photo/1.jpg',
  )
  console.log('fi-img:// 协议读图:', imgOk ? 'OK' : 'FAIL')
  if (!imgOk) throw new Error('fi-img:// 协议读图失败')

  // 路径穿越：协议侧应 404（resolvePath 拦截）
  const traversalStatus = await win.evaluate(async () => {
    try {
      const r = await fetch('fi-img://photo/..%2Fdata.db')
      return r.status
    } catch {
      return 'blocked'
    }
  })
  console.log('fi-img:// 路径穿越拦截:', traversalStatus)
  if (traversalStatus === 200) throw new Error('路径穿越没被拦住')

  // photo:delete：删文件 + 清 photo_path
  await win.evaluate(() => window.fi.invoke('photo:delete', { productId: 1 }))
  if (fs.existsSync(path.join(imagesDir, '1.jpg'))) throw new Error('photo:delete 没删文件')
  const after = await win.evaluate(() => window.fi.invoke('data:loadAll'))
  const p1 = after.products.find((p) => p.id === 1)
  console.log('photo:delete 后 photo_path:', p1.photo_path)
  if (p1.photo_path !== null) throw new Error('photo:delete 没清 photo_path')

  console.log('商品图片 Electron 实跑验证全部通过')
  await app.close()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
