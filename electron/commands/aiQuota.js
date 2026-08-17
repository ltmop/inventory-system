// AI 功能每日额度（v3.0）：按版本限每日用量，超额提示升级会员。
// 视觉识别：普通版 20 次/天、进阶版 100 次/天、大师版不限。
// 铁律：任何环节挂掉静默放行（不阻断识别主流程），读不到版本按免费最严算。
import { readLevelFromDb } from '../license.js'

/** 各版本 AI 视觉每日额度（次/天）；Infinity=不限 */
export const AI_QUOTAS = {
  free: 20,
  pro: 100,
  max: Infinity,
}

const FEATURES = ['vision']

function todayStr() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 读某功能今日已用次数 */
function usedCount(db, feature) {
  try {
    const row = db
      .prepare('SELECT count FROM ai_usage WHERE usage_date = ? AND feature = ?')
      .get(todayStr(), feature)
    return row?.count ?? 0
  } catch {
    return 0
  }
}

/** 某功能当前版本今日额度（剩余次数）；大师版返回 Infinity */
export function aiQuotaStatus(db, feature = 'vision') {
  const level = readLevelFromDb(db)
  const limit = AI_QUOTAS[level] ?? AI_QUOTAS.free
  const used = FEATURES.includes(feature) ? usedCount(db, feature) : 0
  return {
    feature,
    level,
    limit,
    used,
    remaining: Number.isFinite(limit) ? Math.max(0, limit - used) : Infinity,
    unlimited: !Number.isFinite(limit),
  }
}

/**
 * 检查某功能是否还有今日额度。
 * 返回 { allow, message }；allow=false 时 message 是大白话提示（超额要升级）。
 */
export function checkAiQuota(db, feature = 'vision') {
  const s = aiQuotaStatus(db, feature)
  if (s.unlimited) return { allow: true }
  if (s.used < s.limit) return { allow: true }
  const planName = { free: '普通版', pro: '进阶版', max: '大师版' }[s.level] ?? '普通版'
  return {
    allow: false,
    message: `今日 AI 视觉识别 ${s.limit} 次已用完（${planName}每日额度）。升级进阶版/大师版可解锁更多次数。`,
  }
}

/** 记录一次使用（当天该功能计数 +1） */
export function recordAiUsage(db, feature = 'vision') {
  if (!FEATURES.includes(feature)) return
  try {
    db.prepare(
      `INSERT INTO ai_usage (usage_date, feature, count) VALUES (?, ?, 1)
       ON CONFLICT(usage_date, feature) DO UPDATE SET count = count + 1`,
    ).run(todayStr(), feature)
  } catch {
    // 记录失败不影响主流程（下次按现有 count 判断）
  }
}
