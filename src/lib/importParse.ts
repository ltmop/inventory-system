// 批量导入解析：CSV（papaparse）和 xlsx（exceljs）共用同一条表头映射 + 校验管线
import Papa from 'papaparse'
import ExcelJS from 'exceljs'
import { type Category } from '@/types'

// 表头映射：用户表格列名 → 系统字段（中英文都认，兼容模板里的"(元)"后缀）
const HEADER_MAP: Record<string, string> = {
  sku编码: 'sku_code', sku: 'sku_code', sku_code: 'sku_code',
  条码: 'barcode', 条形码: 'barcode', barcode: 'barcode',
  品类: 'category', 大类: 'category', category: 'category',
  子类: 'sub_category', sub_category: 'sub_category',
  品牌: 'brand', brand: 'brand',
  型号: 'model', 规格: 'model', model: 'model',
  进价: 'cost_price', 成本: 'cost_price', cost_price: 'cost_price', '进价(元)': 'cost_price',
  售价: 'suggest_price', 建议售价: 'suggest_price', suggest_price: 'suggest_price', '建议售价(元)': 'suggest_price',
  数量: 'quantity', 库存: 'quantity', quantity: 'quantity',
  货位: 'location', 库位: 'location', location: 'location',
  // 可选规格列（颜色/材质/保质期，空着也能导入）
  长度: 'rod_length', 竿长: 'rod_length', rod_length: 'rod_length',
  调性: 'rod_action', rod_action: 'rod_action',
  硬度: 'power_rating', power_rating: 'power_rating',
  线号: 'line_number', line_number: 'line_number',
  钩号: 'hook_size', hook_size: 'hook_size',
  颜色: 'color', color: 'color',
  材质: 'material', material: 'material',
  保质期: 'expiry_date', expiry_date: 'expiry_date',
}

export interface ImportRow {
  sku_code: string
  barcode?: string
  category: Category
  sub_category?: string
  brand?: string
  model?: string
  cost_price: number // 分
  suggest_price?: number
  quantity: number
  location?: string
  operator?: string
  // 可选规格（颜色/材质/保质期）
  rod_length?: string
  rod_action?: string
  power_rating?: string
  line_number?: string
  hook_size?: string
  color?: string
  material?: string
  expiry_date?: string
  __line: number // 行号，用于错误定位
  __errors: string[] // 校验错误
}

// 模板列头（第一行）和示例数据（第二行）；规格列可选，空着也能导入
export const TEMPLATE_HEADERS = ['sku编码', '品类', '子类', '品牌', '型号', '进价(元)', '建议售价(元)', '数量', '货位', '长度', '调性', '硬度', '线号', '钩号', '颜色', '材质', '保质期']
const TEMPLATE_EXAMPLE = ['SP-001', '饮料', '瓶装水', '农夫山泉', '550ml', 110, 200, 10, 'A区-饮料架', '红色', '塑料', '']

const REQUIRED_LABELS: Record<string, string> = {
  sku_code: 'sku编码', category: '品类', cost_price: '进价', quantity: '数量',
}

/** 表头+数据行（二维字符串数组）→ ImportRow[]，CSV 与 xlsx 共用的解析/校验管线 */
export function rowsToImport(lines: string[][]): ImportRow[] {
  if (lines.length < 2) throw new Error('表格里没有数据：第一行是列名，从第二行开始填商品')

  // 解析表头（去 BOM、去空白、小写化后走映射表）
  const headers = lines[0].map((h) => h.trim().replace(/^﻿/, '').toLowerCase())
  const fieldMap = new Map<number, string>()
  for (let i = 0; i < headers.length; i++) {
    const mapped = HEADER_MAP[headers[i]]
    if (mapped) fieldMap.set(i, mapped)
  }
  if (fieldMap.size === 0) {
    throw new Error('表格的列名对不上，请点「下载导入模板」，在模板里填写，第一行的列名不要改')
  }
  // 必要字段检查
  const required = ['sku_code', 'category', 'cost_price', 'quantity']
  const missing = required.filter((r) => ![...fieldMap.values()].includes(r))
  if (missing.length > 0) {
    throw new Error(`表格里缺少必要列：${missing.map((m) => REQUIRED_LABELS[m]).join('、')}。请对照下载的模板补齐`)
  }

  // 解析数据行
  const result: ImportRow[] = []
  for (let li = 1; li < lines.length; li++) {
    const cols = lines[li].map((c) => c.trim())
    const row: any = { __line: li + 1, __errors: [] }
    for (const [ci, field] of fieldMap) {
      const val = cols[ci] ?? ''
      switch (field) {
        case 'cost_price':
        case 'suggest_price':
          // 元 → 分
          row[field] = val ? Math.round(parseFloat(val) * 100) : null
          break
        case 'quantity':
          row[field] = parseInt(val, 10) || 0
          break
        default:
          row[field] = val || null
      }
    }
    // 校验
    if (!row.sku_code || !row.sku_code.trim()) row.__errors.push('sku编码为空')
    if (!row.category || !row.category.trim()) row.__errors.push('品类不能为空')
    if (row.cost_price == null || isNaN(row.cost_price) || row.cost_price <= 0) row.__errors.push('进价无效')
    if (row.quantity == null || isNaN(row.quantity) || row.quantity < 0) row.__errors.push('数量无效')
    result.push(row as ImportRow)
  }
  return result
}

/** 解析 CSV/TSV 文本 */
export function parseCSVText(text: string): ImportRow[] {
  // papaparse 自动识别逗号/Tab 分隔，正确处理引号包裹字段（手写 split 会把引号内的逗号切碎）
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true })
  return rowsToImport(parsed.data)
}

/** 解析 xlsx 文件内容（取第一个工作表，单元格按显示文本读取） */
export async function parseXlsxBuffer(buf: ArrayBuffer): Promise<ImportRow[]> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buf)
  } catch {
    throw new Error('这个表格打不开，可能文件已损坏，或者它不是真正的 Excel 文件。请点「下载导入模板」，在模板里重新填写')
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('这个 Excel 文件里没有任何工作表，请用下载的模板填写')

  const width = ws.actualColumnCount
  const lines: string[][] = []
  ws.eachRow((row) => {
    const cells: string[] = []
    for (let i = 1; i <= width; i++) {
      // cell.text 是单元格的显示文本，数字/日期/富文本都转成字符串
      cells.push(row.getCell(i).text ?? '')
    }
    lines.push(cells)
  })
  const cleaned = lines.filter((l) => l.some((c) => String(c).trim()))
  return rowsToImport(cleaned)
}

/** 生成 xlsx 导入模板（表头 + 一行示例数据），返回可直接下载的 Blob */
export async function buildTemplateBlob(): Promise<Blob> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('商品导入')
  ws.addRow(TEMPLATE_HEADERS)
  ws.getRow(1).font = { bold: true }
  ws.addRow(TEMPLATE_EXAMPLE)
  ws.columns.forEach((col, i) => {
    col.width = Math.max(12, String(TEMPLATE_HEADERS[i]).length * 2 + 4)
  })
  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}
