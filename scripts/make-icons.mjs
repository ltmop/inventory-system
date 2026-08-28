// 应用图标生成：build/icon.png（源图，1254x1254）→
//   build/icon.ico     多尺寸 16/32/48/256（BMP 编码，NSIS/任务栏兼容性最好）
//   electron/icon.png  256x256，随 electron/** 打包进 asar，运行时窗口图标
//   public/favicon.png 128x128，页面 favicon（index.html 引用）
// 纯 Node 实现（node:zlib 解码/编码 PNG），无第三方依赖。
// 用法：node scripts/make-icons.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SRC = path.resolve('build/icon.png')

// ---- PNG 解码（8-bit RGB/RGBA、非隔行，处理全部 5 种扫描线过滤器）----
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')
  let off = 8
  let width = 0, height = 0, bpp = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8], colorType = data[9], interlace = data[12]
      if (bitDepth !== 8 || interlace !== 0) throw new Error(`不支持的 PNG 格式 bitDepth=${bitDepth} interlace=${interlace}`)
      bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : 0
      if (!bpp) throw new Error(`不支持的 PNG 颜色类型 ${colorType}（仅支持 RGB/RGBA）`)
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const px = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = row[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      row[x] = v
    }
    row.copy(prev)
    // 统一展开成 RGBA
    for (let x = 0; x < width; x++) {
      const s = x * bpp, d = (y * width + x) * 4
      px[d] = row[s]; px[d + 1] = row[s + 1]; px[d + 2] = row[s + 2]
      px[d + 3] = bpp === 4 ? row[s + 3] : 255
    }
  }
  return { width, height, px }
}

// ---- 盒式降采样（面积平均，logo 缩小不糊边）----
function downscale(src, tw, th) {
  const { width: sw, height: sh, px } = src
  const out = Buffer.alloc(tw * th * 4)
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * sh) / th), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / th))
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * sw) / tw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / tw))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4
          r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3]
          n++
        }
      }
      const d = (y * tw + x) * 4
      out[d] = Math.round(r / n); out[d + 1] = Math.round(g / n)
      out[d + 2] = Math.round(b / n); out[d + 3] = Math.round(a / n)
    }
  }
  return { width: tw, height: th, px: out }
}

// ---- PNG 编码（RGBA、filter 0）----
function encodePng({ width, height, px }) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- ICO 编码（全部条目用 BMP：BITMAPINFOHEADER + BGRA 底向上像素 + AND 掩码）----
function bmpEntry({ width, height, px }) {
  const andRow = Math.ceil(width / 32) * 4
  const xorSize = width * height * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(width, 4)
  header.writeInt32LE(height * 2, 8) // ICO 里高度记为 2 倍（XOR + AND）
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(xorSize + andRow * height, 20)
  const xor = Buffer.alloc(xorSize)
  for (let y = 0; y < height; y++) {
    const sy = height - 1 - y // 底向上
    for (let x = 0; x < width; x++) {
      const s = (sy * width + x) * 4, d = (y * width + x) * 4
      xor[d] = px[s + 2]; xor[d + 1] = px[s + 1]; xor[d + 2] = px[s]; xor[d + 3] = px[s + 3]
    }
  }
  return Buffer.concat([header, xor, Buffer.alloc(andRow * height)])
}

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + images.length * 16
  const entries = []
  const bodies = []
  for (const img of images) {
    const body = bmpEntry(img)
    const e = Buffer.alloc(16)
    e[0] = img.width >= 256 ? 0 : img.width
    e[1] = img.height >= 256 ? 0 : img.height
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(body.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += body.length
    entries.push(e)
    bodies.push(body)
  }
  return Buffer.concat([header, ...entries, ...bodies])
}

const src = decodePng(fs.readFileSync(SRC))
console.log(`源图：${src.width}x${src.height}`)

fs.writeFileSync(path.resolve('build/icon.ico'), encodeIco([256, 48, 32, 16].map((s) => downscale(src, s, s))))
fs.writeFileSync(path.resolve('electron/icon.png'), encodePng(downscale(src, 256, 256)))
fs.writeFileSync(path.resolve('public/favicon.png'), encodePng(downscale(src, 128, 128)))

for (const f of ['build/icon.ico', 'electron/icon.png', 'public/favicon.png']) {
  console.log(`生成 ${f}（${fs.statSync(f).size} 字节）`)
}
