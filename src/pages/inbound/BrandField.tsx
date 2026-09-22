import { useMemo } from 'react'

import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store/appStore'

/**
 * 品牌输入（2026-09-22 老板要求：录入即规范）。
 *
 * 为什么不再用「写死的预设下拉」：
 *   原来只有一张预设品牌表（光威/老鬼/龙王恨…），**里面没有「狼王」** —— 而狼王在店里是 23 个规格的大牌。
 *   店员只能点「+ 自定义品牌」手打、或者干脆不填，于是 223 个商品里 127 个（57%）品牌是空的，
 *   导致库存页的「品牌」这层树根本立不起来（按品牌字段查狼王只有 2 个）。
 *
 * 现在的做法：**店里已经在用的品牌排在最前**（按用得多排），再补常见品牌；
 * 用 `<datalist>` 而不是 `<Select>` —— 既能选，也**仍然允许自由输入**新品牌（和「子类」一致的交互）。
 */
const COMMON_BRANDS = [
  '光威', '汉鼎', '化氏', '天元', '宝飞龙', '名伦', '开沃', '迪佳', '佳钓尼',
  '龙王恨', '老鬼', '西部风', '丸九', '土肥富', '欧娜', '慕斯达', '千秋', 'BKK',
  'Shimano', 'Abu Garcia', 'Megabass', 'YGK', '东丽', '美人鱼', '大力马', '连球', '阿卢',
]

export function BrandField({
  value,
  onChange,
  listId = 'brand-choices',
}: {
  value: string
  onChange: (v: string) => void
  /** 同一页可能有多个品牌输入，datalist 的 id 必须唯一 */
  listId?: string
}) {
  const products = useAppStore((s) => s.products)
  const choices = useMemo(() => {
    const used = new Map<string, number>()
    for (const p of products) {
      const b = (p.brand || '').trim()
      if (b) used.set(b, (used.get(b) || 0) + 1)
    }
    const mine = [...used.entries()].sort((a, b) => b[1] - a[1]).map(([b]) => b)
    const preset = COMMON_BRANDS.filter((b) => !used.has(b))
    return [...mine, ...preset]
  }, [products])

  return (
    <>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        placeholder="选一个，或直接打，如：狼王"
      />
      <datalist id={listId}>
        {choices.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
    </>
  )
}
