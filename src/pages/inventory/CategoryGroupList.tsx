// 库存页「第二层：某个品牌下的品类」的卡片列表（2026-09-22）
//
// owner 原话（2026-09-22）：「我点击了一个狼王的鱼竿的一个商品，商品下面就可以出来很多规格让我选择…
//   就像一个文件夹一样」+ 之前那句「规格命名格式不同一 / 全部散乱在外」。
//
// 为什么加这一层：第一层（品牌）点进去之后，还是**一行一个规格**平铺。一个品牌下往往同时有
//   鱼竿/鱼线/鱼钩/饵料好几个品类，几十上百个规格混在一屏里，等于把"太乱"从品牌层挪到了品牌里面。
//   中间插一层「品类」后，路径变成 **品牌 → 品类 → 规格**，每层只看 3～10 个格子，才是"文件夹"的感觉。
//
// 刻意不做成额外点击的地方：**该品牌只有一个品类时这一层自动跳过**（直接进规格表），
//   免得为了一件货多点一下。判断在 InventoryPage，不在这里。
import { ChevronRight, FolderTree } from 'lucide-react'

export interface CategoryGroup {
  /** 品类名（products.category） */
  name: string
  /** 该品类下有多少个规格（每个商品就是一个规格） */
  count: number
  /** 合计多少件 */
  stock: number
  /** 其中几个低于预警线 */
  lowCount: number
}

export function CategoryGroupList({
  groups,
  brandName,
  total,
  onOpen,
}: {
  groups: CategoryGroup[]
  /** 当前所在品牌，用来在标题上说清"在谁里面数" */
  brandName: string
  /** 该品牌下的规格总数 */
  total: number
  onOpen: (name: string) => void
}) {
  if (groups.length === 0) return null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <FolderTree className="size-4 text-brand-600" />
        <span>
          「{brandName}」下有 <span className="font-semibold text-foreground">{groups.length}</span> 个品类 ·{' '}
          <span className="font-semibold text-foreground">{total}</span> 个规格
        </span>
        <span className="text-xs">点品类进去看规格与数量</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {groups.map((g) => (
          <button
            key={g.name}
            onClick={() => onOpen(g.name)}
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
