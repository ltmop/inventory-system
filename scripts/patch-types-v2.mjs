import fs from 'node:fs'

let types = fs.readFileSync('src/types/index.ts', 'utf8')

// 1. Add fishing attributes to Product
const oldStatus = '  name_vi: string | null\n  status: ProductStatus'
const newStatus = '  name_vi: string | null\n  rod_length: string | null\n  line_number: string | null\n  hook_size: string | null\n  color: string | null\n  material: string | null\n  rod_action: string | null\n  power_rating: string | null\n  expiry_date: string | null\n  status: ProductStatus'
types = types.replace(oldStatus, newStatus)
console.log('Fishing attributes added to Product')

// 2. Add PO + PriceTier types before Supplier
const oldSupplier = 'export interface Supplier {'
const newTypes = `// ---------- 采购订单（v2.0） ----------

export type POStatus = 'draft' | 'sent' | 'partial' | 'complete' | 'cancelled'
export const PO_STATUSES: POStatus[] = ['draft', 'sent', 'partial', 'complete', 'cancelled']

export interface PurchaseOrder {
  id: number
  po_no: string
  supplier_id: number | null
  status: POStatus
  expected_arrival: string | null
  total_cost: number | null
  created_at: string
  updated_at: string
  operator: string | null
  notes: string | null
}

export interface PurchaseOrderItem {
  id: number
  po_id: number
  product_id: number | null
  product_desc: string | null
  category: string | null
  quantity: number
  received_qty: number
  unit_cost: number
  created_at: string
}

// ---------- 多级定价（v2.0） ----------

export type PriceLevel = 'retail' | 'regular' | 'VIP' | 'wholesale' | 'promo'
export const PRICE_LEVELS: PriceLevel[] = ['retail', 'regular', 'VIP', 'wholesale', 'promo']

export interface PriceTier {
  id: number
  product_id: number
  tier: PriceLevel
  price: number
}

export interface Supplier {`

if (types.includes(oldSupplier)) {
  types = types.replace(oldSupplier, newTypes)
  console.log('PO + PriceTier types added')
} else {
  console.log('Supplier pattern NOT FOUND')
}

fs.writeFileSync('src/types/index.ts', types)
console.log('Done')
