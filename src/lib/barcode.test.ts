// CODE128-B 编码单测：起始符/校验位/终止符必须严格符合规范，扫码枪才扫得出
import { describe, expect, it } from 'vitest'
import {
  CODE128_PATTERNS,
  START_B,
  STOP,
  code128Modules,
  encodeCode128B,
} from './barcode'

describe('CODE128 码条表', () => {
  it('共 107 个码条，起始/数据/校验 6 段，终止符 7 段', () => {
    expect(CODE128_PATTERNS).toHaveLength(107)
    for (let i = 0; i <= 105; i++) {
      expect(CODE128_PATTERNS[i]).toHaveLength(6)
    }
    expect(CODE128_PATTERNS[106]).toHaveLength(7)
  })

  it('每个数据码条 11 模块，终止符 13 模块（规范硬要求）', () => {
    for (let i = 0; i <= 105; i++) {
      const sum = [...CODE128_PATTERNS[i]].reduce((s, ch) => s + Number(ch), 0)
      expect(sum).toBe(11)
    }
    const stopSum = [...CODE128_PATTERNS[106]].reduce((s, ch) => s + Number(ch), 0)
    expect(stopSum).toBe(13)
  })
})

describe('encodeCode128B', () => {
  it('首码是 B 起始符 104，末码是终止符 106', () => {
    const codes = encodeCode128B('6923456789012')
    expect(codes[0]).toBe(START_B)
    expect(codes[codes.length - 1]).toBe(STOP)
  })

  it('数据字符按 ASCII-32 编码', () => {
    // A=65→33, B=66→34, C=67→35
    const codes = encodeCode128B('ABC')
    expect(codes.slice(1, 4)).toEqual([33, 34, 35])
  })

  it('校验位 = (起始符 + Σ位置×码值) mod 103（手算样例）', () => {
    // "ABC"：104 + 1×33 + 2×34 + 3×35 = 310，310 mod 103 = 1
    expect(encodeCode128B('ABC')).toEqual([104, 33, 34, 35, 1, 106])
    // "0"：码值 48-32=16，校验 = (104 + 1×16) mod 103 = 17
    expect(encodeCode128B('0')).toEqual([104, 16, 17, 106])
  })

  it('SKU 编码（大写字母+数字+连字符）可正常编码', () => {
    const codes = encodeCode128B('JC-FG-SG-GW-36')
    expect(codes[0]).toBe(START_B)
    expect(codes.length).toBe(1 + 14 + 1 + 1)
    // 校验位必须落在 0~102
    expect(codes[codes.length - 2]).toBeGreaterThanOrEqual(0)
    expect(codes[codes.length - 2]).toBeLessThanOrEqual(102)
  })

  it('空串报错，中文等非 ASCII 字符报错', () => {
    expect(() => encodeCode128B('')).toThrow('不能为空')
    expect(() => encodeCode128B('赤刃')).toThrow('不支持字符')
  })
})

describe('code128Modules', () => {
  it('总模块数 = 11×(起始+数据+校验) + 13(终止符)', () => {
    // "ABC"：起始+3 数据+校验 = 5 个 11 模块码 + 终止符 13 = 68
    expect(code128Modules(encodeCode128B('ABC'))).toBe(68)
    // 13 位数字条码：起始+13+校验 = 15 个 11 模块码 + 13 = 178
    expect(code128Modules(encodeCode128B('6923456789012'))).toBe(178)
  })

  it('非法码值报错', () => {
    expect(() => code128Modules([999])).toThrow('非法码值')
  })
})
