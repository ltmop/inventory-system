// 导入解析单测：CSV 与 xlsx 走同一条表头映射 + 校验管线
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import {
  buildTemplateBlob, parseCSVText, parseXlsxBuffer, rowsToImport, TEMPLATE_HEADERS,
} from './importParse'

const HEADER = 'sku编码,品类,子类,品牌,型号,进价,建议售价,数量,货位'

/** 用 exceljs 造一个 xlsx buffer（模拟用户上传的文件） */
async function makeXlsx(rows: (string | number)[][]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('sheet1')
  rows.forEach((r) => ws.addRow(r))
  const buf = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe('parseCSVText', () => {
  it('正常解析：元转分、数量取整', () => {
    const rows = parseCSVText(`${HEADER}\nJC-1,饮料,手竿,汉鼎,一号 3.6m,45.00,85.00,10,A区-1层`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sku_code: 'JC-1', category: '饮料', cost_price: 4500, suggest_price: 8500, quantity: 10,
    })
    expect(rows[0].__errors).toEqual([])
    expect(rows[0].__line).toBe(2)
  })

  it('缺必要列时抛出中文大白话错误', () => {
    expect(() => parseCSVText('sku编码,品类\nJC-1,饮料')).toThrow('缺少必要列')
  })

  it('列名完全对不上时提示用模板', () => {
    expect(() => parseCSVText('foo,bar\n1,2')).toThrow('下载导入模板')
  })

  it('空品类/非法进价写进 __errors 而不是抛错', () => {
    const rows = parseCSVText(`${HEADER}\nJC-1,,,,-5,,10,`)
    expect(rows[0].__errors.join()).toContain('品类')
    expect(rows[0].__errors.join()).toContain('进价无效')
  })

  it('渔具规格列透传，空列为 null', () => {
    const rows = parseCSVText(
      'sku编码,品类,进价,数量,长度,调性,钩号,保质期\n' +
        'JC-9,饮料,45,10,3.6m,28调,,\n' +
        'JC-10,鱼钩,3,20,,,伊势尼5号,',
    )
    expect(rows[0]).toMatchObject({ rod_length: '3.6m', rod_action: '28调' })
    expect(rows[0].hook_size).toBeNull()
    expect(rows[1].hook_size).toBe('伊势尼5号')
    expect(rows[0].__errors).toEqual([])
  })
})

describe('parseXlsxBuffer', () => {
  it('解析 exceljs 生成的 xlsx，与 CSV 结果一致', async () => {
    const buf = await makeXlsx([
      HEADER.split(','),
      ['JC-1', '饮料', '手竿', '汉鼎', '一号 3.6m', 45, 85, 10, 'A区-1层'],
    ])
    const rows = await parseXlsxBuffer(buf)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sku_code: 'JC-1', cost_price: 4500, suggest_price: 8500, quantity: 10 })
    expect(rows[0].__errors).toEqual([])
  })

  it('支持模板里的"进价(元)"列头', async () => {
    const buf = await makeXlsx([
      TEMPLATE_HEADERS,
      ['JC-2', '零食', 'PE线', 'YGK', 'PE 1.5号', 18, 35, 25, 'C区'],
    ])
    const rows = await parseXlsxBuffer(buf)
    expect(rows[0]).toMatchObject({ sku_code: 'JC-2', cost_price: 1800, quantity: 25 })
    expect(rows[0].__errors).toEqual([])
  })

  it('跳过空行，行号按实际数据行编号', async () => {
    const buf = await makeXlsx([
      HEADER.split(','),
      ['JC-1', '饮料', '', '', '', 10, '', 5, ''],
      ['', '', '', '', '', '', '', '', ''],
      ['JC-2', '鱼钩', '', '', '', 3, '', 7, ''],
    ])
    const rows = await parseXlsxBuffer(buf)
    expect(rows).toHaveLength(2)
    expect(rows[1].sku_code).toBe('JC-2')
  })

  it('损坏的文件抛中文大白话错误，不抛英文堆栈', async () => {
    const garbage = new TextEncoder().encode('这不是一个xlsx文件').buffer as ArrayBuffer
    await expect(parseXlsxBuffer(garbage)).rejects.toThrow('这个表格打不开')
  })

  it('xlsx 列头对不上时提示用模板', async () => {
    const buf = await makeXlsx([['甲', '乙'], ['1', '2']])
    await expect(parseXlsxBuffer(buf)).rejects.toThrow('下载导入模板')
  })
})

describe('buildTemplateBlob', () => {
  it('生成的模板能被自家解析器读回，示例行零错误', async () => {
    const blob = await buildTemplateBlob()
    const buf = await blob.arrayBuffer()
    const rows = await parseXlsxBuffer(buf)
    expect(rows).toHaveLength(1)
    expect(rows[0].sku_code).toBe('SP-001')
    expect(rows[0].cost_price).toBe(11000)
    expect(rows[0].__errors).toEqual([])
  })
})

describe('rowsToImport 边界', () => {
  it('只有表头没有数据行时报错', () => {
    expect(() => rowsToImport([HEADER.split(',')])).toThrow('表格里没有数据')
  })
})
