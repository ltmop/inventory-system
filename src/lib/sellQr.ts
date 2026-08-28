// 商品开单二维码：贴纸上的码 = 手机看店地址 + barcode 参数。
// 微信扫一扫 → 打开手机页 → 自动锁定该商品进入开单（见 server.js 手机页 deepBarcode 处理）。

/** 拼开单链接：serverUrl 是 server:status 返回的手机看店地址（已含 ?token=...） */
export function sellQrUrl(serverUrl: string, code: string): string {
  const sep = serverUrl.includes('?') ? '&' : '?'
  return `${serverUrl}${sep}barcode=${encodeURIComponent(code)}`
}

/** 贴纸码内容：有条码用条码（与商品包装一致），没用 SKU */
export function sellQrCodeOf(p: { barcode: string | null; sku_code: string }): string {
  return p.barcode ?? p.sku_code
}
