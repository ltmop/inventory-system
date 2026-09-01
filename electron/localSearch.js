// localSearch（M3-1 纯逻辑）：本地模糊搜索兜底算法，orchestrator 与单测共用。
// 口径（顾问评审 9.3）：只从传入的商品名列表里选候选，绝不凭空造名——
//   纠错结果必然映射到已存在商品（兜底口径 = 主路径口径）。不依赖 electron/网络/KEY，可被单测直接导入。
export function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[m][n]
}

/**
 * 本地模糊匹配：子串/前缀/品牌段编辑距离（≤2），返回最佳候选。
 * 断网/无 KEY 时仍可用（顾问评审 9.3：本地兜底优先，AI 只增强）。
 * 对比品牌段（全名第一个词）而非全名——避免 model 后缀把编辑距离拖大。
 */
export function localFuzzyMatch(text, productNames) {
  const t = String(text || '').trim().toLowerCase()
  if (!t) return null
  let best = null
  let bestScore = Infinity
  for (const name of productNames) {
    const n = String(name).toLowerCase()
    const brandSeg = n.split(' ')[0] // 品牌段（适配 brand model 结构）
    if (n === t) return { name, score: 0, method: 'exact' }
    if (n.includes(t)) {
      const s = n.length - t.length
      if (s < bestScore) { bestScore = s; best = { name, score: s, method: 'substr' } }
      continue
    }
    if (brandSeg.includes(t)) {
      const s = brandSeg.length - t.length
      if (s < bestScore) { bestScore = s; best = { name, score: s, method: 'brand' } }
      continue
    }
    if (t.includes(brandSeg) && brandSeg.length >= 2) {
      const s = t.length - brandSeg.length
      if (s < bestScore) { bestScore = s; best = { name, score: s, method: 'brand-contains' } }
      continue
    }
    const d = levenshtein(t, brandSeg)
    if (d <= 2 && d < bestScore) { bestScore = d; best = { name, score: d, method: 'brand-fuzzy' } }
  }
  return best
}
