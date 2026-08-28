import { describe, expect, it } from 'vitest'
import { sellQrCodeOf, sellQrUrl } from './sellQr'

describe('sellQrUrl（开单二维码链接）', () => {
  it('手机看店地址已带 ?token= → 用 & 拼 barcode', () => {
    expect(sellQrUrl('http://192.168.1.100:17532/?token=abc', '6900001')).toBe(
      'http://192.168.1.100:17532/?token=abc&barcode=6900001',
    )
  })

  it('地址没带参数 → 用 ? 拼', () => {
    expect(sellQrUrl('http://192.168.1.100:17532/', 'YL-001')).toBe(
      'http://192.168.1.100:17532/?barcode=YL-001',
    )
  })

  it('码内容含特殊字符要编码（中文 SKU / 斜杠）', () => {
    expect(sellQrUrl('http://h/', '慈海/慈瀚')).toBe(
      `http://h/?barcode=${encodeURIComponent('慈海/慈瀚')}`,
    )
  })
})

describe('sellQrCodeOf（贴纸码内容）', () => {
  it('有条码用条码', () => {
    expect(sellQrCodeOf({ barcode: '6900000000001', sku_code: 'YL-001' })).toBe('6900000000001')
  })
  it('没条码回退 SKU', () => {
    expect(sellQrCodeOf({ barcode: null, sku_code: 'YL-001' })).toBe('YL-001')
  })
})
