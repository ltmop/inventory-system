// appStore 浏览器 mock 回退路径的单测（无 Electron 后端时的本地逻辑）
// 每个用例用独立 fixture 注入 store，不依赖 mock-data 的具体数值
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore, priceForCustomer } from './appStore'
import type { Customer, InventoryBatch, PriceTier, Product, StockTake, StockTakeItem } from '@/types'

const baseProduct: Product = {
  id: 1,
  sku_code: 'JC-FG-SG-GW-001',
  barcode: '6900000000001',
  category: '鱼竿',
  sub_category: '手竿',
  brand: '光威',
  model: '测试竿 3.6m',
  cost_price: 4200,
  suggest_price: 8500,
  location: 'A区-东墙',
  photo_path: null,
  name_vi: null,
  rod_length: null,
  line_number: null,
  hook_size: null,
  color: null,
  material: null,
  rod_action: null,
  power_rating: null,
  expiry_date: null,
  min_stock: null,
  status: '已盘点',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
}

// 两个批次：先入 3 条 @40元，后入 5 条 @45元（FIFO 必须先扣 id=1）
const baseBatches: InventoryBatch[] = [
  { id: 1, product_id: 1, batch_no: 'PO20260701-001', quantity: 3, cost_price: 4000, location: 'A区-东墙', inbound_date: '2026-07-01', supplier_id: null },
  { id: 2, product_id: 1, batch_no: 'PO20260710-001', quantity: 5, cost_price: 4500, location: 'A区-东墙', inbound_date: '2026-07-10', supplier_id: null },
]

function seed(overrides: Partial<Parameters<typeof useAppStore.setState>[0]> = {}) {
  useAppStore.setState({
    products: [structuredClone(baseProduct)],
    batches: structuredClone(baseBatches),
    transactions: [],
    suppliers: [],
    stockTakes: [],
    stockTakeItems: [],
    customers: [],
    payments: [],
    purchaseOrders: [],
    purchaseOrderItems: [],
    priceTiers: [],
    loaded: true,
    error: null,
    ...overrides,
  })
}

beforeEach(() => seed())

describe('addInbound（mock 路径）', () => {
  it('追加批次和入库流水，并刷新商品最新进价', async () => {
    await useAppStore.getState().addInbound({
      productId: 1, quantity: 10, costPrice: 5000,
      location: 'A区-东墙', supplierId: null, operator: '测试员',
    })
    const s = useAppStore.getState()
    expect(s.batches).toHaveLength(3)
    const nb = s.batches[2]
    expect(nb.quantity).toBe(10)
    expect(nb.cost_price).toBe(5000)
    expect(nb.batch_no).toMatch(/^PO\d{8}-\d{3}$/)
    const tx = s.transactions[0]
    expect(tx.type).toBe('in')
    expect(tx.unit_price).toBe(5000)
    expect(tx.batch_id).toBe(nb.id)
    expect(s.products[0].cost_price).toBe(5000)
  })
})

describe('confirmOutbound（mock 路径 FIFO）', () => {
  it('跨批次扣减：先扣完整最早批次，再扣次早批次', async () => {
    const r = await useAppStore.getState().confirmOutbound(1, 4, 8000, '测试员')
    expect(r.ok).toBe(true)
    const s = useAppStore.getState()
    expect(s.batches.find((b) => b.id === 1)!.quantity).toBe(0)
    expect(s.batches.find((b) => b.id === 2)!.quantity).toBe(4)
    const outs = s.transactions.filter((t) => t.type === 'out')
    expect(outs).toHaveLength(2)
    // unit_price = 批次成本价，selling_price = 实际售价
    const byBatch = new Map(outs.map((t) => [t.batch_id, t]))
    expect(byBatch.get(1)!.quantity).toBe(3)
    expect(byBatch.get(1)!.unit_price).toBe(4000)
    expect(byBatch.get(1)!.selling_price).toBe(8000)
    expect(byBatch.get(2)!.quantity).toBe(1)
    expect(byBatch.get(2)!.unit_price).toBe(4500)
  })

  it('不填售价时 selling_price 为 null（显示层兜底为 -）', async () => {
    await useAppStore.getState().confirmOutbound(1, 1, null, '测试员')
    const tx = useAppStore.getState().transactions.find((t) => t.type === 'out')!
    expect(tx.selling_price).toBeNull()
    expect(tx.unit_price).toBe(4000)
  })

  it('库存不足返回 shortage 且不改动任何状态', async () => {
    const before = useAppStore.getState()
    const r = await useAppStore.getState().confirmOutbound(1, 99, 8000, '测试员')
    expect(r).toEqual({ ok: false, shortage: 91 })
    const after = useAppStore.getState()
    expect(after.batches).toEqual(before.batches)
    expect(after.transactions).toHaveLength(0)
  })
})

describe('addProduct（mock 路径 SKU 自动生成）', () => {
  const input = {
    sku_code: '',
    barcode: null,
    category: '鱼竿' as const,
    sub_category: '手竿',
    brand: '光威',
    model: '新竿',
    cost_price: 1000,
    suggest_price: null,
    location: null,
    status: '待盘点' as const,
  }

  it('sku_code 留空无条码时自动编纯数字号（1001 起递增）', async () => {
    // 规则与后端一致：显式 SKU > 条码 > 纯数字编号（6 位以内纯数字取 max+1）
    const p1 = await useAppStore.getState().addProduct(input)
    expect(p1.sku_code).toBe('1001')
    const p2 = await useAppStore.getState().addProduct(input)
    expect(p2.sku_code).toBe('1002')
  })

  it('sku_code 留空有条码时直接用条码，且条码不占数字编号序列', async () => {
    const p1 = await useAppStore.getState().addProduct({ ...input, barcode: '6901234567890' })
    expect(p1.sku_code).toBe('6901234567890')
    const p2 = await useAppStore.getState().addProduct(input)
    expect(p2.sku_code).toBe('1001')
    await expect(useAppStore.getState().addProduct({ ...input, barcode: '6901234567890' })).rejects.toThrow('条码')
  })

  it('显式传入 sku_code 时原样保留', async () => {
    const p = await useAppStore.getState().addProduct({ ...input, sku_code: 'JC-QT-XX-XX-999' })
    expect(p.sku_code).toBe('JC-QT-XX-XX-999')
  })
})

describe('updateProduct / deleteProduct（mock 路径）', () => {
  it('updateProduct 可改资料但 SKU 不可变', async () => {
    await useAppStore.getState().updateProduct(1, { model: '改名竿', sku_code: 'HACK' } as never)
    const p = useAppStore.getState().products[0]
    expect(p.model).toBe('改名竿')
    expect(p.sku_code).toBe('JC-FG-SG-GW-001')
  })

  it('deleteProduct 无记录商品可删，有批次/流水的拒绝', async () => {
    await expect(useAppStore.getState().deleteProduct(1)).rejects.toThrow('停产')
    seed({ batches: [], transactions: [] })
    await useAppStore.getState().deleteProduct(1)
    expect(useAppStore.getState().products).toHaveLength(0)
  })
})

describe('completeStockTake（mock 路径）', () => {
  it('按实盘数落实批次库存并完结盘点单', async () => {
    const take: StockTake = {
      id: 1, take_no: 'ST20260728-001', status: '进行中',
      location_filter: null, started_at: '2026-07-28T10:00:00.000Z', completed_at: null, operator: '测试员',
    }
    const items: StockTakeItem[] = [
      { id: 1, stock_take_id: 1, product_id: 1, batch_id: 1, system_qty: 3, actual_qty: 2, difference: -1, reason: '损耗' },
      { id: 2, stock_take_id: 1, product_id: 1, batch_id: 2, system_qty: 5, actual_qty: null, difference: null, reason: '' },
    ]
    seed({ stockTakes: [take], stockTakeItems: items })
    await useAppStore.getState().completeStockTake(1)
    const s = useAppStore.getState()
    expect(s.batches.find((b) => b.id === 1)!.quantity).toBe(2)
    // 未填实盘数的批次不动
    expect(s.batches.find((b) => b.id === 2)!.quantity).toBe(5)
    const t = s.stockTakes[0]
    expect(t.status).toBe('已完成')
    expect(t.completed_at).toBeTruthy()
  })
})

describe('submitStockTake（mock 路径，原子提交）', () => {
  it('一次调用完成实盘写入 + 批次落实 + 完结', async () => {
    const take: StockTake = {
      id: 1, take_no: 'ST20260728-002', status: '进行中',
      location_filter: null, started_at: '2026-07-28T10:00:00.000Z', completed_at: null, operator: '测试员',
    }
    const items: StockTakeItem[] = [
      { id: 1, stock_take_id: 1, product_id: 1, batch_id: 1, system_qty: 3, actual_qty: null, difference: null, reason: '' },
      { id: 2, stock_take_id: 1, product_id: 1, batch_id: 2, system_qty: 5, actual_qty: null, difference: null, reason: '' },
    ]
    seed({ stockTakes: [take], stockTakeItems: items })
    await useAppStore.getState().submitStockTake(1, [
      { itemId: 1, actualQty: 2, reason: '损耗' },
      { itemId: 2, actualQty: 7, reason: '漏记' },
    ])
    const s = useAppStore.getState()
    expect(s.stockTakeItems[0].actual_qty).toBe(2)
    expect(s.stockTakeItems[0].difference).toBe(-1)
    expect(s.stockTakeItems[1].actual_qty).toBe(7)
    expect(s.batches.find((b) => b.id === 1)!.quantity).toBe(2)
    expect(s.batches.find((b) => b.id === 2)!.quantity).toBe(7)
    expect(s.stockTakes[0].status).toBe('已完成')
  })
})

describe('addReturn（mock 路径）', () => {
  it('退货加回最近批次并记 return 流水', async () => {
    await useAppStore.getState().addReturn(1, 2, 8000, '测试员')
    const s = useAppStore.getState()
    // 最近批次是 id=2（入库日期更晚）
    expect(s.batches.find((b) => b.id === 2)!.quantity).toBe(7)
    expect(s.batches.find((b) => b.id === 1)!.quantity).toBe(3)
    const tx = s.transactions[0]
    expect(tx.type).toBe('return')
    expect(tx.batch_id).toBe(2)
    expect(tx.unit_price).toBe(4500) // 最近批次的成本
    expect(tx.selling_price).toBe(8000) // 退款金额
    expect(tx.notes).toBe('退货回补')
  })

  it('无批次商品退货自动建批次，成本取商品最近进价', async () => {
    seed({ batches: [] })
    await useAppStore.getState().addReturn(1, 1, 5000, '测试员')
    const s = useAppStore.getState()
    expect(s.batches).toHaveLength(1)
    expect(s.batches[0].quantity).toBe(1)
    expect(s.batches[0].cost_price).toBe(4200) // 商品 cost_price
    expect(s.transactions[0].type).toBe('return')
  })

  it('商品不存在时抛错', async () => {
    await expect(useAppStore.getState().addReturn(999, 1, 100, '测试员')).rejects.toThrow('商品不存在')
  })
})

// ---------- 赊账包（mock 回退路径） ----------
const baseCustomer: Customer = {
  id: 1,
  name: '老王',
  phone: '13800000000',
  notes: null,
  price_level: null,
  created_at: '2026-07-01T00:00:00.000Z',
}

describe('赊账出库（mock 路径）', () => {
  it('先欠着：paid_amount=0，客户欠款=应付总额', async () => {
    seed({ customers: [{ ...baseCustomer, outstanding: 0, total_credit: 0, total_paid_back: 0, last_deal_at: null }] })
    const r = await useAppStore.getState().confirmOutbound(1, 2, 8000, '测试员', { customerId: 1, paidAmount: 0 })
    expect(r.ok).toBe(true)
    const s = useAppStore.getState()
    const outs = s.transactions.filter((t) => t.type === 'out')
    expect(outs.every((t) => t.customer_id === 1 && t.paid_amount === 0)).toBe(true)
    const cust = s.customers.find((c) => c.id === 1)!
    expect(cust.outstanding).toBe(16000)
    expect(cust.total_credit).toBe(16000)
  })

  it('付一部分：实收按批次行摊销，欠款=应付-实收', async () => {
    seed({ customers: [{ ...baseCustomer, outstanding: 0, total_credit: 0, total_paid_back: 0, last_deal_at: null }] })
    // 跨批次出 4 条 @80元，应付 320，先付 200
    await useAppStore.getState().confirmOutbound(1, 4, 8000, '测试员', { customerId: 1, paidAmount: 20000 })
    const s = useAppStore.getState()
    const outs = s.transactions.filter((t) => t.type === 'out')
    const paidSum = outs.reduce((sum, t) => sum + (t.paid_amount ?? 0), 0)
    expect(paidSum).toBe(20000)
    expect(s.customers.find((c) => c.id === 1)!.outstanding).toBe(12000)
  })

  it('散客部分付款被拒：赊账必须选客户', async () => {
    await expect(
      useAppStore.getState().confirmOutbound(1, 1, 8000, '测试员', { paidAmount: 100 }),
    ).rejects.toThrow('赊账必须选客户')
  })

  it('全额收款：paid_amount 保持 null（全额付清），不欠钱', async () => {
    seed({ customers: [{ ...baseCustomer, outstanding: 0, total_credit: 0, total_paid_back: 0, last_deal_at: null }] })
    await useAppStore.getState().confirmOutbound(1, 1, 8000, '测试员', { customerId: 1 })
    const s = useAppStore.getState()
    expect(s.transactions[0].paid_amount).toBeNull()
    expect(s.customers.find((c) => c.id === 1)!.outstanding).toBe(0)
  })
})

// ---------- 一单多商品收银台（mock 回退路径） ----------
const cartProduct2: Product = {
  ...baseProduct,
  id: 2,
  sku_code: 'JC-FG-SG-GW-002',
  brand: '测试',
  model: '鱼线 0.8号',
  cost_price: 500,
  suggest_price: 900,
}
const cartBatches2: InventoryBatch[] = [
  { id: 3, product_id: 2, batch_no: 'PO20260705-001', quantity: 2, cost_price: 500, location: null, inbound_date: '2026-07-05', supplier_id: null },
]
const seedCartCustomer = { ...baseCustomer, outstanding: 0, total_credit: 0, total_paid_back: 0, last_deal_at: null }
function seedTwoProducts(withCustomer = false) {
  seed({
    products: [structuredClone(baseProduct), structuredClone(cartProduct2)],
    batches: [...structuredClone(baseBatches), ...structuredClone(cartBatches2)],
    customers: withCustomer ? [{ ...seedCartCustomer }] : [],
  })
}

describe('checkout 收银台（mock 路径：一单多商品）', () => {
  it('多样一单：逐行扣库存、逐行落流水、到账方式一致', async () => {
    seedTwoProducts()
    const r = await useAppStore.getState().checkout(
      [
        { productId: 1, quantity: 4, sellingPrice: 8000 },
        { productId: 2, quantity: 2, sellingPrice: 900 },
      ],
      '测试员',
      { payMethod: '微信' },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.totalDue).toBe(33800)
      expect(r.creditAmount).toBe(0)
    }
    const s = useAppStore.getState()
    expect(s.batches.find((b) => b.id === 1)!.quantity).toBe(0)
    expect(s.batches.find((b) => b.id === 2)!.quantity).toBe(4)
    expect(s.batches.find((b) => b.id === 3)!.quantity).toBe(0)
    const outs = s.transactions.filter((t) => t.type === 'out')
    expect(outs).toHaveLength(3) // 商品1跨两批次拆 2 行 + 商品2 一行
    expect(outs.every((t) => t.pay_method === '微信')).toBe(true)
    expect(outs.every((t) => t.paid_amount == null)).toBe(true)
  })

  it('任一行缺货：整单不动并列出缺货明细', async () => {
    seedTwoProducts()
    const before = useAppStore.getState()
    const r = await useAppStore.getState().checkout(
      [
        { productId: 1, quantity: 2, sellingPrice: 8000 },
        { productId: 2, quantity: 99, sellingPrice: 900 },
      ],
      '测试员',
    )
    expect(r.ok).toBe(false)
    if (!r.ok && 'shortages' in r) {
      expect(r.shortages).toHaveLength(1)
      expect(r.shortages[0].productId).toBe(2)
      expect(r.shortages[0].shortage).toBe(97)
    }
    const after = useAppStore.getState()
    expect(after.batches).toEqual(before.batches)
    expect(after.transactions).toHaveLength(0)
  })

  it('赊账一单：实收按行顺序摊销，欠款=应付-实收', async () => {
    seedTwoProducts(true)
    // 应付 2×8000 + 1×900 = 16900，实收 10000 → 商品1 行摊满 10000，商品2 行摊 0
    const r = await useAppStore.getState().checkout(
      [
        { productId: 1, quantity: 2, sellingPrice: 8000 },
        { productId: 2, quantity: 1, sellingPrice: 900 },
      ],
      '测试员',
      { customerId: 1, paidAmount: 10000, payMethod: '现金' },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.totalDue).toBe(16900)
      expect(r.creditAmount).toBe(6900)
    }
    const s = useAppStore.getState()
    const paids = s.transactions
      .filter((t) => t.type === 'out')
      .map((t) => t.paid_amount ?? -1)
      .sort((a, b) => a - b)
    expect(paids).toEqual([0, 10000])
    expect(s.customers.find((c) => c.id === 1)!.outstanding).toBe(6900)
  })

  it('纯赊账：到账方式强制落空，欠款=全额', async () => {
    seedTwoProducts(true)
    const r = await useAppStore.getState().checkout(
      [{ productId: 1, quantity: 1, sellingPrice: 8000 }],
      '测试员',
      { customerId: 1, paidAmount: 0, payMethod: '现金' },
    )
    expect(r.ok).toBe(true)
    const tx = useAppStore.getState().transactions.find((t) => t.type === 'out')!
    expect(tx.pay_method).toBeNull()
    expect(tx.paid_amount).toBe(0)
    expect(useAppStore.getState().customers.find((c) => c.id === 1)!.outstanding).toBe(8000)
  })

  it('散客部分付款被拒：赊账必须选客户', async () => {
    seedTwoProducts()
    await expect(
      useAppStore.getState().checkout([{ productId: 1, quantity: 1, sellingPrice: 8000 }], '测试员', { paidAmount: 100 }),
    ).rejects.toThrow('赊账必须选客户')
  })
})

describe('还账 / 赊账退货冲减（mock 路径）', () => {
  async function seedWithDebt() {
    seed({ customers: [{ ...baseCustomer, outstanding: 0, total_credit: 0, total_paid_back: 0, last_deal_at: null }] })
    await useAppStore.getState().confirmOutbound(1, 2, 8000, '测试员', { customerId: 1, paidAmount: 0 })
  }

  it('还账后欠款减少，多还变预收', async () => {
    await seedWithDebt()
    const r1 = await useAppStore.getState().recordPayment({ customerId: 1, amount: 6000, method: '现金' })
    expect(r1.outstanding).toBe(10000)
    const r2 = await useAppStore.getState().recordPayment({ customerId: 1, amount: 12000, method: '微信' })
    expect(r2.outstanding).toBe(-2000)
    expect(r2.prepaid).toBe(true)
    expect(r2.overpaid).toBe(true)
    expect(useAppStore.getState().payments).toHaveLength(2)
  })

  it('赊账销售的退货传 customerId，欠款被冲减', async () => {
    await seedWithDebt()
    await useAppStore.getState().addReturn(1, 1, 8000, '测试员', 1)
    const s = useAppStore.getState()
    const ret = s.transactions.find((t) => t.type === 'return')!
    expect(ret.customer_id).toBe(1)
    expect(s.customers.find((c) => c.id === 1)!.outstanding).toBe(8000)
  })

  it('对账单：赊销明细（应付/已付/欠）+ 还款记录', async () => {
    await seedWithDebt()
    await useAppStore.getState().recordPayment({ customerId: 1, amount: 6000, method: '现金' })
    const st = await useAppStore.getState().customerStatement(1)
    expect(st.customer.name).toBe('老王')
    expect(st.sales.length).toBeGreaterThan(0)
    const owedSum = st.sales.reduce((sum, x) => sum + x.owed, 0)
    expect(owedSum).toBe(16000)
    expect(st.payments).toHaveLength(1)
    expect(st.outstanding).toBe(10000)
  })

  it('有流水/还款记录的客户不能删除', async () => {
    await seedWithDebt()
    await expect(useAppStore.getState().deleteCustomer(1)).rejects.toThrow('不能删除')
  })
})

describe('createStockTake 品类/供应商筛选（mock 路径）', () => {
  it('按品类筛选只生成该品类明细，盘点单记下筛选条件', async () => {
    const take = await useAppStore.getState().createStockTake(null, '测试员', { category: '鱼线' })
    expect(take.category_filter).toBe('鱼线')
    const items = useAppStore.getState().stockTakeItems.filter((it) => it.stock_take_id === take.id)
    expect(items).toHaveLength(0) // fixture 里只有鱼竿
  })

  it('不筛选时生成全部有库存批次明细', async () => {
    const take = await useAppStore.getState().createStockTake(null, '测试员')
    const items = useAppStore.getState().stockTakeItems.filter((it) => it.stock_take_id === take.id)
    expect(items).toHaveLength(2)
  })
})

// ---------- 采购订单 + 多级定价（mock 回退路径） ----------

describe('采购订单（mock 路径）', () => {
  it('建单：生成单号、明细，状态为待收货，总金额自动算', async () => {
    const po = await useAppStore.getState().createPurchaseOrder({
      supplierId: 1,
      items: [{ productId: 1, quantity: 10, costPrice: 4200 }],
      notes: '测试订货',
    })
    expect(po.po_no).toMatch(/^PO\d{8}-\d{3}$/)
    const s = useAppStore.getState()
    const order = s.purchaseOrders.find((o) => o.id === po.id)!
    expect(order.status).toBe('sent')
    expect(order.total_cost).toBe(42000)
    expect(order.total_qty).toBe(10)
    expect(order.received_qty).toBe(0)
    const items = s.purchaseOrderItems.filter((it) => it.po_id === po.id)
    expect(items).toHaveLength(1)
    expect(items[0].product_name).toContain('光威')
  })

  it('分批收货：建批次加库存、推进度，收齐后状态变已完成', async () => {
    const before = useAppStore.getState().totalStockOf(1)
    const po = await useAppStore.getState().createPurchaseOrder({
      supplierId: 1,
      items: [{ productId: 1, quantity: 10, costPrice: 4200 }],
    })
    const itemId = useAppStore.getState().purchaseOrderItems.find((it) => it.po_id === po.id)!.id

    // 先收 4 件：部分收货，库存 +4，批次成本用订单进价
    const r1 = await useAppStore.getState().receivePurchaseOrder(po.id, [
      { itemId, quantity: 4 },
    ])
    expect(r1.receivedTotal).toBe(4)
    let s = useAppStore.getState()
    expect(s.purchaseOrders.find((o) => o.id === po.id)!.status).toBe('partial')
    expect(s.totalStockOf(1)).toBe(before + 4)
    const batch = s.batches.find((b) => b.batch_no === po.po_no)!
    expect(batch.cost_price).toBe(4200)
    expect(s.transactions.some((t) => t.type === 'in' && t.notes === `采购收货 ${po.po_no}`)).toBe(
      true,
    )

    // 再收剩余 6 件：收齐变已完成
    await useAppStore.getState().receivePurchaseOrder(po.id, [{ itemId, quantity: 6 }])
    s = useAppStore.getState()
    expect(s.purchaseOrders.find((o) => o.id === po.id)!.status).toBe('complete')
    expect(s.totalStockOf(1)).toBe(before + 10)
  })

  it('收货不能超过待收数量', async () => {
    const po = await useAppStore.getState().createPurchaseOrder({
      supplierId: 1,
      items: [{ productId: 1, quantity: 5, costPrice: 4200 }],
    })
    const itemId = useAppStore.getState().purchaseOrderItems.find((it) => it.po_id === po.id)!.id
    await expect(
      useAppStore.getState().receivePurchaseOrder(po.id, [{ itemId, quantity: 6 }]),
    ).rejects.toThrow('最多还能收 5 件')
  })

  it('取消订单：已收保留、状态变已取消，取消后不能再收货', async () => {
    const po = await useAppStore.getState().createPurchaseOrder({
      supplierId: 1,
      items: [{ productId: 1, quantity: 5, costPrice: 4200 }],
    })
    await useAppStore.getState().cancelPurchaseOrder(po.id)
    expect(useAppStore.getState().purchaseOrders.find((o) => o.id === po.id)!.status).toBe(
      'cancelled',
    )
    const itemId = useAppStore.getState().purchaseOrderItems.find((it) => it.po_id === po.id)!.id
    await expect(
      useAppStore.getState().receivePurchaseOrder(po.id, [{ itemId, quantity: 1 }]),
    ).rejects.toThrow('不能再收货')
  })

  it('详情：本地拼出订单头 + 明细', async () => {
    const po = await useAppStore.getState().createPurchaseOrder({
      supplierId: 1,
      items: [{ productId: 1, quantity: 2, costPrice: 4200 }],
    })
    const d = await useAppStore.getState().purchaseOrderDetail(po.id)
    expect(d.order.po_no).toBe(po.po_no)
    expect(d.items).toHaveLength(1)
    expect(d.items[0].quantity).toBe(2)
  })
})

describe('价格档次（mock 路径）', () => {
  it('设置/覆盖/删除某商品某档价格', async () => {
    await useAppStore.getState().setPriceTier(1, 'wholesale', 7200)
    let s = useAppStore.getState()
    expect(s.priceTiers.find((t) => t.product_id === 1 && t.tier === 'wholesale')!.price).toBe(
      7200,
    )
    await useAppStore.getState().setPriceTier(1, 'wholesale', 7000)
    s = useAppStore.getState()
    expect(s.priceTiers.filter((t) => t.product_id === 1 && t.tier === 'wholesale')).toHaveLength(
      1,
    )
    expect(s.priceTiers.find((t) => t.product_id === 1 && t.tier === 'wholesale')!.price).toBe(
      7000,
    )
    await useAppStore.getState().deletePriceTier(1, 'wholesale')
    s = useAppStore.getState()
    expect(
      s.priceTiers.some((t) => t.product_id === 1 && t.tier === 'wholesale'),
    ).toBe(false)
  })
})

// ---------- 价格档自动化 + 换货差价（mock 回退路径） ----------

describe('priceForCustomer（客户价格档自动定价）', () => {
  const tiers: PriceTier[] = [
    { id: 1, product_id: 1, tier: 'retail', price: 8500 },
    { id: 2, product_id: 1, tier: 'wholesale', price: 7200 },
  ]

  it('客户设了档且商品设了这档价 → 用档次价', () => {
    expect(priceForCustomer(baseProduct, tiers, { price_level: 'wholesale' })).toEqual({
      price: 7200,
      tier: 'wholesale',
    })
  })

  it('商品没设客户这档 → 回退建议价，不报错', () => {
    expect(priceForCustomer(baseProduct, tiers, { price_level: 'VIP' })).toEqual({
      price: 8500, // baseProduct.suggest_price
      tier: null,
    })
  })

  it('散客/没设档的客户按零售档；零售也没设回退建议价', () => {
    expect(priceForCustomer(baseProduct, tiers, null)).toEqual({ price: 8500, tier: 'retail' })
    expect(priceForCustomer(baseProduct, tiers, { price_level: null })).toEqual({
      price: 8500,
      tier: 'retail',
    })
    expect(priceForCustomer(baseProduct, [], null)).toEqual({ price: 8500, tier: null })
  })
})

describe('客户默认价格档（mock 路径）', () => {
  it('建档/改档/清档都能存住 price_level', async () => {
    const c = await useAppStore.getState().addCustomer({
      name: '码头张老板', phone: null, notes: null, price_level: 'wholesale',
    })
    expect(c.price_level).toBe('wholesale')
    expect(useAppStore.getState().customers.find((x) => x.id === c.id)!.price_level).toBe(
      'wholesale',
    )
    await useAppStore.getState().updateCustomer(c.id, {
      name: '码头张老板', phone: null, notes: null, price_level: 'VIP',
    })
    expect(useAppStore.getState().customers.find((x) => x.id === c.id)!.price_level).toBe('VIP')
    // 传 null 清除，回零售默认
    await useAppStore.getState().updateCustomer(c.id, {
      name: '码头张老板', phone: null, notes: null, price_level: null,
    })
    expect(useAppStore.getState().customers.find((x) => x.id === c.id)!.price_level).toBeNull()
  })
})

describe('confirmOutbound 价格档（mock 路径）', () => {
  it('没传显式售价但传了档 → 按档定价；没设这档回退建议价；显式售价优先', async () => {
    seed({ priceTiers: [{ id: 1, product_id: 1, tier: 'wholesale', price: 7200 }] })
    await useAppStore.getState().confirmOutbound(1, 1, null, '测试员', { tier: 'wholesale' })
    expect(useAppStore.getState().transactions[0].selling_price).toBe(7200)

    await useAppStore.getState().confirmOutbound(1, 1, null, '测试员', { tier: 'VIP' })
    expect(useAppStore.getState().transactions[0].selling_price).toBe(8500) // 回退建议价

    await useAppStore.getState().confirmOutbound(1, 1, 9000, '测试员', { tier: 'wholesale' })
    expect(useAppStore.getState().transactions[0].selling_price).toBe(9000) // 显式售价优先
  })
})

describe('换货差价（mock 路径）', () => {
  // 新货：product 2，一批 5 件 @60元成本，建议价 120
  const product2: Product = {
    ...baseProduct,
    id: 2,
    sku_code: 'JC-FG-SG-GW-002',
    barcode: null,
    model: '测试竿 4.5m',
    cost_price: 6000,
    suggest_price: 12000,
  }
  const batch2: InventoryBatch = {
    id: 10, product_id: 2, batch_no: 'PO20260701-002', quantity: 5,
    cost_price: 6000, location: null, inbound_date: '2026-07-01', supplier_id: null,
  }
  const custSeed = {
    customers: [{ ...baseCustomer, outstanding: 0, total_credit: 0, total_paid_back: 0, last_deal_at: null }],
  }
  const seedTwo = () => seed({ products: [structuredClone(baseProduct), product2], batches: [...structuredClone(baseBatches), batch2], ...custSeed })

  it('旧货没找到售价记录 → 按建议价算差价（oldPriceSource=suggest）', async () => {
    seedTwo()
    const r = await useAppStore.getState().addExchange(1, 2, 1, 10000, '测试员')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.oldPriceSource).toBe('suggest')
    expect(r.oldUnitPrice).toBe(8500)
    expect(r.diff).toBe(1500) // 10000 - 8500
    expect(r.diffPaid).toBe(1500) // 省略实收=差价全额付清
    expect(r.diffCredit).toBe(0)
  })

  it('新货贵要补钱：补的钱先欠着 → 欠款只记差价部分（旧货价值视为已付）', async () => {
    seedTwo()
    // 旧货先按 80 元全款卖过一条 → 旧腿原售价 8000
    await useAppStore.getState().confirmOutbound(1, 1, 8000, '测试员')
    // 换 100 元的新货：差价 2000，只补 500，剩 1500 记老王账上
    const r = await useAppStore.getState().addExchange(1, 2, 1, 10000, '测试员', {
      customerId: 1,
      diffPaidAmount: 500,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.oldPriceSource).toBe('transaction')
    expect(r.diff).toBe(2000)
    expect(r.diffPaid).toBe(500)
    expect(r.diffCredit).toBe(1500)
    const s = useAppStore.getState()
    // 新腿流水：实收 = 新腿应付 - 赊欠差额 = 10000 - 1500 = 8500
    const outTx = s.transactions.find((t) => t.notes === '换货出新')!
    expect(outTx.customer_id).toBe(1)
    expect(outTx.paid_amount).toBe(8500)
    // 老王欠款只多了差价赊欠的 1500
    expect(s.customers.find((c) => c.id === 1)!.outstanding).toBe(1500)
  })

  it('补的钱要赊账但没选客户 → 拒绝', async () => {
    seedTwo()
    await useAppStore.getState().confirmOutbound(1, 1, 8000, '测试员')
    await expect(
      useAppStore.getState().addExchange(1, 2, 1, 10000, '测试员', { diffPaidAmount: 500 }),
    ).rejects.toThrow('赊账必须选客户')
    // 实收超过差价 → 拒绝
    await expect(
      useAppStore.getState().addExchange(1, 2, 1, 10000, '测试员', { customerId: 1, diffPaidAmount: 9999 }),
    ).rejects.toThrow('差价实收不能超过差价')
  })

  it('新货便宜要退钱：原单赊账未付清 → 差价从他欠款里扣', async () => {
    seedTwo()
    // 老王纯赊 80 元买走一条旧货
    await useAppStore.getState().confirmOutbound(1, 1, 8000, '测试员', { customerId: 1, paidAmount: 0 })
    expect(useAppStore.getState().customers.find((c) => c.id === 1)!.outstanding).toBe(8000)
    // 换 50 元的新货：差价 -3000，冲减欠款
    const r = await useAppStore.getState().addExchange(1, 2, 1, 5000, '测试员', { customerId: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.diff).toBe(-3000)
    expect(r.refund).toBe(3000)
    expect(r.refundHandling).toBe('credit_offset')
    expect(r.refundCustomerId).toBe(1)
    const s = useAppStore.getState()
    const diffTx = s.transactions.find((t) => t.type === 'exchange')!
    expect(diffTx.customer_id).toBe(1)
    expect(diffTx.paid_amount).toBe(-3000)
    // 欠款 8000 - 3000 = 5000
    expect(s.customers.find((c) => c.id === 1)!.outstanding).toBe(5000)
  })

  it('新货便宜要退钱：原单已全款 → 退现金（不冲欠款）', async () => {
    seedTwo()
    await useAppStore.getState().confirmOutbound(1, 1, 8000, '测试员') // 散客全款
    const r = await useAppStore.getState().addExchange(1, 2, 1, 5000, '测试员')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.diff).toBe(-3000)
    expect(r.refundHandling).toBe('cash')
    const diffTx = useAppStore.getState().transactions.find((t) => t.type === 'exchange')!
    expect(diffTx.customer_id).toBeNull()
    expect(diffTx.paid_amount).toBe(-3000)
  })
})


describe('batchUpdateProducts（mock 路径）', () => {
  const product2: Product = {
    ...structuredClone(baseProduct),
    id: 2,
    sku_code: 'JC-XL-PL-001',
    brand: '批量牌',
    model: '线B',
    suggest_price: 999,
  }
  // 无建议售价的商品：打折时保持 NULL，不补建档次
  const product3: Product = {
    ...structuredClone(baseProduct),
    id: 3,
    sku_code: 'JC-YG-PL-001',
    brand: '批量牌',
    model: '钩C',
    suggest_price: null,
  }
  const tierSeed: PriceTier[] = [
    { id: 1, product_id: 1, tier: 'VIP', price: 1500 },
    { id: 2, product_id: 2, tier: 'wholesale', price: 777 },
  ]
  const seedBatch = () =>
    seed({
      products: [structuredClone(baseProduct), structuredClone(product2), structuredClone(product3)],
      priceTiers: structuredClone(tierSeed),
    })

  it('统一打折：建议售价与已设档次价同步四舍五入，并记一条批量改价日志', async () => {
    seedBatch()
    const r = await useAppStore.getState().batchUpdateProducts({
      ids: [1, 2, 3],
      priceMode: { kind: 'ratio', ratio: 0.9 },
    })
    expect(r).toEqual({ ok: true, updated: 3, tiersUpdated: 2 })
    const s = useAppStore.getState()
    expect(s.products.find((p) => p.id === 1)!.suggest_price).toBe(7650) // 8500×0.9
    expect(s.products.find((p) => p.id === 2)!.suggest_price).toBe(899) // 999×0.9=899.1→899
    expect(s.products.find((p) => p.id === 3)!.suggest_price).toBeNull() // 没设的不补
    expect(s.priceTiers.find((t) => t.product_id === 1)!.price).toBe(1350) // 1500×0.9
    expect(s.priceTiers.find((t) => t.product_id === 2)!.price).toBe(699) // 777×0.9=699.3→699
    const logs = s.auditLogs.filter((l) => l.action === '批量改价')
    expect(logs).toHaveLength(1)
    expect(logs[0].entity).toContain('3 个商品')
  })

  it('统一改价：建议售价与档次价都改成固定价', async () => {
    seedBatch()
    await useAppStore.getState().batchUpdateProducts({
      ids: [1, 2],
      priceMode: { kind: 'fixed', priceFen: 500 },
    })
    const s = useAppStore.getState()
    expect(s.products.find((p) => p.id === 1)!.suggest_price).toBe(500)
    expect(s.products.find((p) => p.id === 2)!.suggest_price).toBe(500)
    expect(s.priceTiers.every((t) => t.price === 500)).toBe(true)
    expect(s.products.find((p) => p.id === 3)!.suggest_price).toBeNull() // 不在名单里不动
  })

  it('批量改状态：只动选中商品，记一条批量改状态日志', async () => {
    seedBatch()
    await useAppStore.getState().batchUpdateProducts({ ids: [1, 3], status: '停产' })
    const s = useAppStore.getState()
    expect(s.products.find((p) => p.id === 1)!.status).toBe('停产')
    expect(s.products.find((p) => p.id === 3)!.status).toBe('停产')
    expect(s.products.find((p) => p.id === 2)!.status).toBe('已盘点')
    const logs = s.auditLogs.filter((l) => l.action === '批量改状态')
    expect(logs).toHaveLength(1)
    expect(logs[0].entity).toContain('2 个商品')
    expect(logs[0].entity).toContain('停产')
  })

  it('非法参数抛错：空列表 / 什么都不传 / 坏折扣 / 负统一价 / 非法状态 / 商品不存在', async () => {
    seedBatch()
    const st = useAppStore.getState()
    await expect(st.batchUpdateProducts({ ids: [], priceMode: { kind: 'ratio', ratio: 0.9 } })).rejects.toThrow()
    await expect(st.batchUpdateProducts({ ids: [1] })).rejects.toThrow()
    await expect(st.batchUpdateProducts({ ids: [1], priceMode: { kind: 'ratio', ratio: 0 } })).rejects.toThrow()
    await expect(st.batchUpdateProducts({ ids: [1], priceMode: { kind: 'fixed', priceFen: -5 } })).rejects.toThrow()
    // 状态必须是合法枚举（'在售' 已是合法状态，改用非法值验证校验）
    await expect(st.batchUpdateProducts({ ids: [1], status: '非法状态' as never })).rejects.toThrow()
    const before = useAppStore.getState()
    await expect(
      st.batchUpdateProducts({ ids: [1, 999999], priceMode: { kind: 'ratio', ratio: 0.5 } }),
    ).rejects.toThrow('商品不存在')
    // 失败不落任何修改
    const after = useAppStore.getState()
    expect(after.products).toEqual(before.products)
    expect(after.priceTiers).toEqual(before.priceTiers)
    expect(after.auditLogs).toEqual(before.auditLogs)
  })
})


describe('支出记账（mock 路径）', () => {
  const sup = { id: 1, name: '测试供应商', contact: null, phone: null, address: null, notes: null }

  it('记/改/删一笔支出，日期默认今天', async () => {
    seed({ expenses: [], suppliers: [sup] })
    const st = useAppStore.getState()
    const e = await st.addExpense({
      category: '房租', amount: 280000, method: '现金', note: '7月房租', supplierId: 1,
    })
    expect(e.id).toBeGreaterThan(0)
    expect(e.expense_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(e.supplier_name).toBe('测试供应商')
    expect(useAppStore.getState().expenses).toHaveLength(1)

    await useAppStore.getState().updateExpense(e.id, {
      category: '水电', amount: 18600, method: '微信', expenseDate: '2026-07-15',
    })
    const updated = useAppStore.getState().expenses[0]
    expect(updated.category).toBe('水电')
    expect(updated.amount).toBe(18600)
    expect(updated.expense_date).toBe('2026-07-15')
    expect(updated.supplier_id).toBeNull()

    await useAppStore.getState().deleteExpense(e.id)
    expect(useAppStore.getState().expenses).toHaveLength(0)
    await expect(useAppStore.getState().deleteExpense(e.id)).rejects.toThrow('不存在')
  })

  it('非法参数抛错：坏分类 / 零金额 / 坏方式 / 坏日期 / 供应商不存在', async () => {
    seed({ expenses: [], suppliers: [] })
    const st = useAppStore.getState()
    // @ts-expect-error 故意传非法分类
    await expect(st.addExpense({ category: '旅游', amount: 100, method: '现金' })).rejects.toThrow('分类')
    await expect(st.addExpense({ category: '房租', amount: 0, method: '现金' })).rejects.toThrow('金额')
    // @ts-expect-error 故意传非法方式
    await expect(st.addExpense({ category: '房租', amount: 100, method: '刷卡' })).rejects.toThrow('方式')
    await expect(
      st.addExpense({ category: '房租', amount: 100, method: '现金', expenseDate: '昨天' }),
    ).rejects.toThrow('日期')
    await expect(
      st.addExpense({ category: '进货付款', amount: 100, method: '现金', supplierId: 999 }),
    ).rejects.toThrow('供应商')
    expect(useAppStore.getState().expenses).toHaveLength(0)
  })
})
