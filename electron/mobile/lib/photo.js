// photo.js: 手机端商品图片 —— 拍照/相册选图 → 压缩 → 存到**账本所在那台机器** → 挂到商品上
//
// 与桌面端同源同库，不另做"同步"：
//   · 图片文件落在账本机器的 data/images/<商品id>.<jpg>（中心库模式 = 中心库服务器）
//   · products.photo_path 只存文件名，跟着账本走
//   · 所以手机上拍的图，电脑上（修好绝对地址后）和手机上都看得到
//
// photo:save 只落盘、不动数据库（与桌面端一致），挂到商品要再调一次 product:update。
(function () {
  // 与桌面端同口径：最长边 800px、JPEG 0.85（一张一般 <300KB，手机流量友好）
  var MAX_EDGE = 800
  var QUALITY = 0.85

  /**
   * 弹拍照/相册，返回压缩后的 base64（不含 data: 前缀）。用户取消返回 null。
   * 注意：手机浏览器/WebView 取消选图时不会触发任何事件，此时这个 Promise 不结算 ——
   * 调用方不要 await 后就假设一定有图（本文件只在 onchange 里结算）。
   */
  function pickPhoto() {
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.capture = 'environment'
      input.onchange = function () {
        var file = input.files && input.files[0]
        if (!file) return resolve(null)
        var reader = new FileReader()
        reader.onload = function () {
          var img = new Image()
          img.onload = function () {
            try {
              var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height))
              var w = Math.max(1, Math.round(img.width * scale))
              var h = Math.max(1, Math.round(img.height * scale))
              var canvas = document.createElement('canvas')
              canvas.width = w
              canvas.height = h
              canvas.getContext('2d').drawImage(img, 0, 0, w, h)
              resolve(canvas.toDataURL('image/jpeg', QUALITY).split(',')[1] || null)
            } catch (e) { reject(e) }
          }
          img.onerror = function () { reject(new Error('图片读取失败')) }
          img.src = String(reader.result)
        }
        reader.onerror = function () { reject(new Error('图片读取失败')) }
        reader.readAsDataURL(file)
      }
      input.click()
    })
  }

  /**
   * 存图 + 挂到商品。返回落盘后的相对文件名。
   * 两步都走命令层（photo:save / product:update），手机与电脑共用同一套口径。
   */
  async function saveProductPhoto(productId, base64) {
    if (!productId) throw new Error('这家商品还没有 id，先建档')
    if (!base64) throw new Error('没有图片内容')
    var r = await api('photo:save', { productId: productId, base64: base64, ext: 'jpg' })
    if (!r || !r.ok || !r.path) throw new Error('图片保存失败')
    await api('product:update', { id: productId, photo_path: r.path })
    return r.path
  }

  /**
   * photo_path → <img src> 可用地址（手机端与接口同源，拼绝对地址 + 令牌最稳）。
   * version 用于缓存穿透 —— 换图后文件名不变（还是 <商品id>.jpg），不换 URL 浏览器会拿旧图；
   * 传商品的 updated_at 即可（服务端 updateProduct 每次都刷它）。
   */
  function productPhotoUrl(photoPath, version) {
    if (!photoPath) return ''
    if (String(photoPath).indexOf('data:') === 0) return String(photoPath)
    var v = (version === undefined || version === null || version === '')
      ? ''
      : '&v=' + encodeURIComponent(String(version))
    return SERVER + '/api/photo?path=' + encodeURIComponent(photoPath) + '&token=' + encodeURIComponent(TOKEN) + v
  }

  window.FiPhoto = {
    pickPhoto: pickPhoto,
    saveProductPhoto: saveProductPhoto,
    productPhotoUrl: productPhotoUrl,
  }
})()
