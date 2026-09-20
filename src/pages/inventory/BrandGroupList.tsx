// 库存页「第一层：按品牌」的卡片列表（2026-09-20 owner 要求）
//
// owner 原话：「在库存里不能一进去就看到某个规格，而是子品牌，我想看有哪些规格的时候，
//   再点击进去看规格，规格又分别有哪些数量…现在的这种太乱了，一下子把（一个品牌的）所有规格
//   全部摆在明面上，太多了，渔具这行业的规格又多，而且鱼竿品牌又多，不能这么去放在库存里」
//
// 现实（2026-09-20 拿清空前的 324 个商品量过）：
//   · 商品数 == 不同 SKU 数 == 324 —— **一行就是一个独立规格**，所以第一层写「N 个规格」是准确的
//   · 按品牌分是 58 组（最大的「没填品牌」125 个规格，其余最大「老鬼」23 个）
//   · 平铺表一进去就是 324 行 —— 这才是老板说的"太乱、太杂、太多"
//
// 这一层只回答一个问题：**有哪些品牌、各有多少规格、其中几个缺货**。
// 规格明细（每个规格多少件）在点进去之后的第二层 —— 也就是原来那张表。
import { ChevronRight, Tags } from 'lucide-react'

export interface BrandGroup {
  /** 分组键。没填品牌的商品归到 NO_BRAND 这个哨兵值 */
  key: string
  /** 展示名（没填品牌时显示「没填品牌」） */
  name: string
  /** 该品牌下有多少个规格（每个商品就是一个规格） */
  count: number
  /** 合计多少件 */
  stock: number
  /** 其中几个低于预警线 */
  lowCount: number
}

export function BrandGroupList({
  groups,
  total,
  onOpen,
}: {
  groups: BrandGroup[]
  /** 当前筛选结果里的规格总数（用来在标题上说清"筛完还剩多少"） */
  total: number
  onOpen: (key: string) => void
}) {
  if (groups.length === 0) return null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <Tags className="size-4 text-brand-600" />
        <span>
          共 <span className="font-semibold text-foreground">{groups.length}</span> 个品牌 ·{' '}
          <span className="font-semibold text-foreground">{total}</span> 个规格
        </span>
        <span className="text-xs">点品牌进去看规格与数量</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {groups.map((g) => (
          <button
            key={g.key}
            onClick={() => onOpen(g.key)}
            className="group flex cursor-pointer flex-col gap-1 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/40"
          >
            <div className="flex w-full items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">{g.name}</span>
              <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground/50 group-hover:text-brand-600" />
            </div>
            <div className="text-xs text-muted-foreground">
              {g.count} 个规格 · 共 {g.stock.toLocaleString()} 件
            </div>
            {g.lowCount > 0 && (
              <div className="text-xs font-medium text-red-500">{g.lowCount} 个缺货</div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
