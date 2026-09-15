// 商品模糊搜索的**本地兜底口径**（不含 AI 增强的那部分）。
//
// 为什么单独放命令层（红线①：口径只走 electron/commands/）：
//   同一段搜索要在**两个地方**跑 ——
//     · 桌面端（ai-orchestrator）：本地兜底优先，AI 只做增强
//     · 中心库服务端（server.js）：中心库模式下必须查**服务端那份账**，
//       而 ai-orchestrator 依赖 electron.safeStorage，根本 import 不进服务端
//   两边各写一份 = 口径必然漂移（"AI 建议不得改变搜索口径"是 1.0 架构的铁律）。
//
// 本文件不 import electron，可被 server.js / test-backend.mjs 直接使用。

import { localFuzzyMatch } from '../localSearch.js'

/**
 * 搜索用的候选商品名清单。
 * ⚠️ 这段 SQL 是"搜索能看见哪些商品"的口径，两处必须同源 —— 改这里就同时改了桌面端与服务端。
 */
export function productNamesForSearch(db) {
  try {
    if (!db) return []
    const rows = db
      .prepare("SELECT p.brand, p.model, p.sku_code FROM products p WHERE p.status != '停产' ORDER BY p.id LIMIT 300")
      .all()
    return rows.map((r) => [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code || '').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 本地兜底搜索。
 * @returns {{ decisive: boolean, result: object }}
 *   decisive=true  → 本地已经够准（精确/子串命中），调用方**不必**再问 AI
 *   result         → 可直接回给前端的结果（形状与旧实现完全一致，避免调用方改动）
 */
export function localSearchHit(text, productNames) {
  const t = String(text ?? '').trim()
  if (!t) return { decisive: false, result: { ok: false, reason: 'empty' } }
  const names = Array.isArray(productNames) ? productNames : []
  if (names.length === 0) return { decisive: false, result: { ok: true, corrected: t, matched: false, source: 'none' } }

  const local = localFuzzyMatch(t, names)
  // 精确/子串命中直接返回（最快，不用 AI）
  if (local && local.method !== 'fuzzy' && local.score === 0) {
    return { decisive: true, result: { ok: true, corrected: local.name, matched: true, source: 'local:' + local.method } }
  }
  // 含编辑距离的模糊兜底
  if (local) {
    return { decisive: false, result: { ok: true, corrected: local.name, matched: true, source: 'local:' + local.method } }
  }
  return { decisive: false, result: { ok: true, corrected: t, matched: false, source: 'local:none' } }
}
