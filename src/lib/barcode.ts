// CODE128-B 条码：编码逻辑（纯函数，可单测）与 canvas 绘制分离。
// B 字符集覆盖 ASCII 32~126（数字/大小写字母/常用符号），商品条码和 SKU 都落在这个范围。

/**
 * 107 个码条的宽度序列（条空交替，从黑条开始）。
 * 下标即码值：0~105 每码 6 段共 11 模块；106 终止符 7 段共 13 模块。
 */
export const CODE128_PATTERNS: string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
]

/** B 字符集起始符 / 终止符码值 */
export const START_B = 104
export const STOP = 106

/**
 * 把文本编成 CODE128-B 码值序列：[起始符, ...数据码值, 校验位, 终止符]
 * 校验位 = (起始符 + Σ 位置i×码值i) mod 103，位置从 1 开始
 */
export function encodeCode128B(text: string): number[] {
  if (text.length === 0) throw new Error('条码内容不能为空')
  const values: number[] = []
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code < 32 || code > 126) {
      throw new Error(`CODE128-B 只支持英文/数字/常用符号，不支持字符「${ch}」`)
    }
    values.push(code - 32)
  }
  let checksum = START_B
  values.forEach((v, i) => {
    checksum += (i + 1) * v
  })
  checksum %= 103
  return [START_B, ...values, checksum, STOP]
}

/** 编码结果的条空总模块数（不含左右静区），用于计算画布宽度 */
export function code128Modules(codes: number[]): number {
  return codes.reduce((sum, v) => {
    const pattern = CODE128_PATTERNS[v]
    if (!pattern) throw new Error(`非法码值：${v}`)
    return sum + [...pattern].reduce((s, ch) => s + Number(ch), 0)
  }, 0)
}

export interface DrawCode128Options {
  /** 画布高度（px），默认 64 */
  height?: number
  /** 单模块宽度（px），默认 2；画大一号再用 CSS 缩小，打印更锐利 */
  moduleWidth?: number
  /** 左右静区（模块数），扫码枪要求 ≥10，默认 10 */
  quietZone?: number
}

/** 在 canvas 上画 CODE128-B 条码；返回实际像素尺寸，方便调用方设 CSS 缩放 */
export function drawCode128B(
  canvas: HTMLCanvasElement,
  text: string,
  opts: DrawCode128Options = {},
): { width: number; height: number } {
  const codes = encodeCode128B(text)
  const mw = opts.moduleWidth ?? 2
  const quiet = opts.quietZone ?? 10
  const height = opts.height ?? 64
  const width = (code128Modules(codes) + quiet * 2) * mw

  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return { width, height }

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#000000'
  let x = quiet * mw
  for (const code of codes) {
    let bar = true // 每个码条都从黑条开始，条空交替
    for (const ch of CODE128_PATTERNS[code]) {
      const w = Number(ch) * mw
      if (bar) ctx.fillRect(x, 0, w, height)
      x += w
      bar = !bar
    }
  }
  return { width, height }
}
