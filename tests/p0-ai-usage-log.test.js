// P0 计费阀门 · 客户端本地流水表测试（vitest，随 npm test 与原 186 个一起跑）
// BYOK 不扣费口径：BYOK 调用只写本地 ai_usage_log（channel='byok'），永不经过网关；
// 网关侧余额不动已由 ai-server-src/tests/quota.test.js 覆盖，这里验证本地记账语义。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, finalCheckpoint, recordAiUsageLog, listAiUsageLog, aiUsageStats } from '../electron/db.js'

let dir
let db

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-aiusage-'))
  db = openDatabase(path.join(dir, 'data.db'))
})

afterAll(() => {
  try { finalCheckpoint(db); db.close() } catch { /* 清理失败无碍 */ }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('ai_usage_log 本地流水表（P0 新增，旧 ai_usage 表不动）', () => {
  it('旧 ai_usage 每日配额表仍在（只加不删回归）', () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_usage'").get()
    expect(t?.name).toBe('ai_usage')
  })

  it('网关通道记账：字段完整可回读', () => {
    recordAiUsageLog(db, { feature: 'agent_chat', model: 'deepseek-chat', inputTokens: 100, outputTokens: 50, channel: 'gateway' })
    const rows = listAiUsageLog(db, 5)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ feature: 'agent_chat', model: 'deepseek-chat', inputTokens: 100, outputTokens: 50, totalTokens: 150, channel: 'gateway' })
    expect(rows[0].createdAt).toBeTruthy()
  })

  it('BYOK 通道只记本地：channel=byok，负数/非法输入截 0', () => {
    recordAiUsageLog(db, { feature: 'daily_summary', model: 'moonshot-v1-8k', inputTokens: -5, outputTokens: Number('x'), channel: 'byok' })
    const rows = listAiUsageLog(db, 5)
    const byok = rows.find((r) => r.channel === 'byok')
    expect(byok).toBeTruthy()
    expect(byok.inputTokens).toBe(0)
    expect(byok.outputTokens).toBe(0)
  })

  it('channel 非法值落 gateway 兜底（CHECK 约束不外溢）', () => {
    recordAiUsageLog(db, { feature: 'correct_term', channel: 'weird' })
    const rows = listAiUsageLog(db, 1)
    expect(rows[0].channel).toBe('gateway')
  })

  it('aiUsageStats：本月总量 + 分功能/分通道聚合正确', () => {
    const stats = aiUsageStats(db)
    expect(stats.monthTotalTokens).toBe(150) // 只有第一笔有 token
    const chat = stats.byFeature.find((r) => r.feature === 'agent_chat' && r.channel === 'gateway')
    expect(chat.calls).toBe(1)
    expect(chat.totalTokens).toBe(150)
    const byok = stats.byFeature.find((r) => r.channel === 'byok')
    expect(byok.feature).toBe('daily_summary')
  })
})
