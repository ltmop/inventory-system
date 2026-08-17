// 前端开源化 PoC：refine 接现有后端（window.fi.invoke），做一个库存列表 + 简单开单
// 验证"保住 Node 引擎 + 开源前端框架重做 UI"这条路线，可用后再铺开其他页。
import { Refine } from '@refinedev/core'
import { useTable } from '@refinedev/antd'
import { ConfigProvider, Table, Button, InputNumber, Space, Tag, message } from 'antd'
import { useMemo, useState } from 'react'
import { refineDataProvider } from '@/lib/refineDataProvider'
import { backend } from '@/lib/api'

/** 库存列表：refine useTable + antd Table，CRUD 列表层免写 */
function ProductTable() {
  const { tableProps, tableQuery } = useTable({ resource: 'products' })
  const data = (tableQuery.data?.data ?? []) as any[]

  const columns = useMemo(
    () => [
      { title: 'SKU', dataIndex: 'sku_code', key: 'sku_code' },
      { title: '品牌', dataIndex: 'brand', key: 'brand', render: (v: string | null) => v || '-' },
      { title: '型号', dataIndex: 'model', key: 'model', render: (v: string | null) => v || '-' },
      { title: '分类', dataIndex: 'category', key: 'category', render: (v: string) => <Tag>{v}</Tag> },
      {
        title: '进价(元)',
        dataIndex: 'cost_price',
        key: 'cost_price',
        render: (v: number) => (v / 100).toFixed(2),
      },
      {
        title: '建议售价(元)',
        dataIndex: 'suggest_price',
        key: 'suggest_price',
        render: (v: number | null) => (v ? (v / 100).toFixed(2) : '-'),
      },
      { title: '状态', dataIndex: 'status', key: 'status' },
    ],
    [],
  )

  return (
    <Table
      {...tableProps}
      rowKey="id"
      columns={columns}
      dataSource={data}
      pagination={{ pageSize: 10, showSizeChanger: false }}
      scroll={{ x: 800 }}
    />
  )
}

/** 简单开单：选商品 → 填数量 → 调 outbound:checkout（走现有后端，不动业务逻辑） */
function CheckoutPanel() {
  const { tableQuery } = useTable({ resource: 'products' })
  const products = (tableQuery.data?.data ?? []) as any[]
  const [pid, setPid] = useState<number | null>(null)
  const [qty, setQty] = useState(1)

  const checkout = async () => {
    if (!pid) {
      message.warning('先选一个商品')
      return
    }
    if (!qty || qty <= 0) {
      message.warning('数量要大于 0')
      return
    }
    try {
      const r = await backend?.invoke('outbound:checkout', {
        items: [{ productId: pid, quantity: qty, sellingPrice: null }],
        method: '现金',
        operator: 'PoC',
      })
      if (r?.ok === false) {
        message.error(r?.reason || '开单失败')
      } else {
        message.success(`开单成功，应收 ${((r?.totalDue ?? 0) / 100).toFixed(2)} 元`)
      }
    } catch (e) {
      message.error(`开单失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div style={{ marginTop: 24, padding: 16, border: '1px solid #eee', borderRadius: 8 }}>
      <h3>开单（PoC，走现有 outbound:checkout）</h3>
      <Space wrap>
        <select
          style={{ width: 240, padding: 4 }}
          value={pid ?? ''}
          onChange={(e) => setPid(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">选商品…</option>
          {products.map((p: any) => (
            <option key={p.id} value={p.id}>
              {p.sku_code} · {p.brand} {p.model}
            </option>
          ))}
        </select>
        <InputNumber min={1} value={qty} onChange={(v) => setQty(Number(v) || 1)} />
        <Button type="primary" onClick={checkout}>
          开单
        </Button>
      </Space>
    </div>
  )
}

export function PocPage() {
  return (
    <Refine dataProvider={refineDataProvider}>
      <ConfigProvider theme={{ token: { colorPrimary: '#c9a55a' } }}>
        <div style={{ padding: 24 }}>
          <h2>refine PoC · 前端开源化验证</h2>
          <ProductTable />
          <CheckoutPanel />
        </div>
      </ConfigProvider>
    </Refine>
  )
}
