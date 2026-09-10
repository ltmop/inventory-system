// ============================================================
// P0 计费阀门 · 客户端统一入口（对应代码规范：所有 AI 功能调用走本模块）
// 双通道同一接口，只是"扣不扣钱"开关不同（BYOK 通道陷阱提醒）：
//   官方网关：consumeViaGateway() → 网关查余额→扣费→记账（402 阻断）
//   BYOK：    recordLocalUsage() → 只记本地用量展示，不扣费
// 铁律：
// - 收费功能名一律用 FEATURES 常量，禁止硬编码字符串
// - 余额不足统一 code:402，禁止自定义其他错误码
// - deviceToken / 激活码原文用 safeStorage 加密落盘；客户端永不存上游模型真实 Key
// - 客户端侧所有失败静默降级（返回 {ok:false}），绝不影响主流程
//   （与网关侧"宁可误断不可漏计"相反，是故意区分）
// ============================================================
import { safeStorage } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { machineFingerprint } from './license.js'
import { OFFICIAL_GATEWAY_URL } from './ai.js'
import { recordAiUsageLog } from './db.js'

/** 收费功能名常量表（与网关 ai-server-src/config.js 口径一致，新增功能两边同步加） */
export const FEATURES = Object.freeze({
  AGENT_CHAT: 'agent_chat',
  DAILY_SUMMARY: 'daily_summary',
  CORRECT_TERM: 'correct_term',
  CONNECTION_TEST: 'connection_test',
  VOICE_ORDER: 'voice_order', // P1-3 语音开单 LLM 理解段（离线识别免费，此段收费）
})

/** 余额不足统一错误码（全系统唯一口径） */
export const ERR_INSUFFICIENT = 402

const TIMEOUT_MS = 45_000
const DEVICE_TOKEN_FILE = 'device-token.enc'
const LICENSE_CODE_FILE = 'license-code.enc'

let dataDir = null

/** 主进程启动时调用一次（main.js 在 initAi 之后调用） */
export function initAiQuota(dir) {
  dataDir = dir
}

// ---------- 加密存取（safeStorage，与 ai.js 的 Key 管理同款风格） ----------
function writeEnc(file, plain) {
  try {
    let payload
    try {
      payload = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(plain).toString('base64')
        : `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
    } catch {
      payload = `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
    }
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, file), payload, 'utf8')
    return true
  } catch {
    return false
  }
}

function readEnc(file) {
  try {
    const f = path.join(dataDir, file)
    if (!fs.existsSync(f) || fs.statSync(f).size === 0) return null
    const raw = fs.readFileSync(f, 'utf8')
    if (raw.startsWith('plain:')) return Buffer.from(raw.slice(6), 'base64').toString('utf8')
    return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  } catch {
    return null
  }
}

/** 保存激活码原文（激活成功/老用户重输时调用；供设备注册绑余额用） */
export function saveLicenseCode(code) {
  if (!dataDir || !code) return false
  return writeEnc(LICENSE_CODE_FILE, String(code).trim())
}

export function readLicenseCode() {
  return dataDir ? readEnc(LICENSE_CODE_FILE) : null
}

export function getDeviceToken() {
  return dataDir ? readEnc(DEVICE_TOKEN_FILE) : null
}

// ---------- 设备注册（含匿名试用 + 激活码绑定/迁移） ----------
async function postJson(urlPath, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${OFFICIAL_GATEWAY_URL}${urlPath}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => null)
    return { http: res.status, data }
  } catch (e) {
    return { http: 0, data: null, networkError: e?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

async function registerDevice({ licenseKey = null, deviceToken = null } = {}) {
  const body = {
    deviceName: os.hostname(),
    fingerprint: machineFingerprint(),
  }
  if (licenseKey) body.licenseKey = licenseKey
  if (deviceToken) body.deviceToken = deviceToken
  const r = await postJson('/api/v1/device/register', body)
  if (r.http === 200 && r.data?.ok && r.data.deviceToken) {
    writeEnc(DEVICE_TOKEN_FILE, r.data.deviceToken)
    return { ok: true, ...r.data }
  }
  return { ok: false, reason: r.networkError || r.data?.reason || `http-${r.http}` }
}

/** 确保本机已注册（有缓存直接放行；断网/失败返回 {ok:false}，调用方静默降级） */
export async function ensureRegistered() {
  if (!dataDir) return { ok: false, reason: 'not-init' }
  const cached = getDeviceToken()
  if (cached) return { ok: true, deviceToken: cached, cached: true }
  return registerDevice({ licenseKey: readLicenseCode() })
}

/**
 * 绑定/补绑激活码（激活成功后 + 老用户在额度卡重输激活码时调用）
 * 匿名设备已有用量 → 网关侧迁移到激活码账户
 */
export async function bindLicense(code) {
  const trimmed = String(code ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'empty-code' }
  saveLicenseCode(trimmed)
  const r = await registerDevice({ licenseKey: trimmed, deviceToken: getDeviceToken() })
  return r.ok ? { ok: true, quota: r.quota, migrated: !!r.migrated } : r
}

// ---------- 官方网关消费（代理记账：token 数以网关实读为准） ----------
/**
 * @param {string} feature FEATURES 常量值
 * @param {Array} messages OpenAI 兼容消息
 * @param {{ tools?: Array, maxTokens?: number }} opts
 * @returns {Promise<{ok:true, message:object, usage:object, remaining:number}
 *   | {ok:false, code?:number, reason:string, remaining?:number}>}
 */
export async function consumeViaGateway(feature, messages, opts = {}) {
  const reg = await ensureRegistered()
  if (!reg.ok) return { ok: false, reason: reg.reason || 'register-failed' }
  const deviceToken = getDeviceToken()
  if (!deviceToken) return { ok: false, reason: 'no-device-token' }

  const r = await postJson('/api/v1/ai/proxy', {
    deviceToken,
    feature,
    messages,
    maxTokens: opts.maxTokens,
    tools: opts.tools,
    idempotencyKey: crypto.randomUUID(), // 每次请求生成，网关幂等去重防重试重复扣费
  })

  if (r.networkError) return { ok: false, reason: r.networkError }
  const d = r.data || {}
  if (r.http === 200 && d.success) {
    return { ok: true, message: d.message, usage: d.usage, remaining: d.remaining }
  }
  if (r.http === ERR_INSUFFICIENT || d.code === ERR_INSUFFICIENT) {
    return { ok: false, code: ERR_INSUFFICIENT, reason: 'quota-exceeded', remaining: d.remaining ?? 0 }
  }
  if (r.http === 401) {
    // deviceToken 失效（如换机/网关重置）：清缓存下次重注册
    try { fs.unlinkSync(path.join(dataDir, DEVICE_TOKEN_FILE)) } catch { /* 忽略 */ }
    return { ok: false, reason: 'invalid-device' }
  }
  return { ok: false, code: d.code ?? r.http, reason: d.reason || d.message || `http-${r.http}` }
}

/** BYOK / 网关共用：本地逐笔用量记录（展示用，纯追加，写不进不致命） */
export function recordLocalUsage(db, feature, usage, channel) {
  try {
    if (!db) return
    recordAiUsageLog(db, {
      feature,
      model: usage?.model ?? null,
      inputTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
      channel: channel === 'byok' ? 'byok' : 'gateway',
    })
  } catch { /* 记录失败不影响主流程 */ }
}

// ---------- 余额 / 流水查询（额度卡用） ----------
export async function gatewayQuota() {
  const reg = await ensureRegistered()
  if (!reg.ok) return { ok: false, reason: reg.reason }
  const token = getDeviceToken()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${OFFICIAL_GATEWAY_URL}/api/v1/ai/quota?deviceToken=${encodeURIComponent(token)}`, { signal: controller.signal })
    const d = await res.json().catch(() => null)
    if (res.ok && d?.ok) return { ok: true, ...d, bound: !!readLicenseCode() }
    return { ok: false, reason: d?.reason || `http-${res.status}` }
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

export async function gatewayUsage(limit = 20) {
  const token = getDeviceToken()
  if (!token) return { ok: false, reason: 'no-device-token' }
  try {
    const res = await fetch(`${OFFICIAL_GATEWAY_URL}/api/v1/ai/usage?deviceToken=${encodeURIComponent(token)}&limit=${Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200)}`)
    const d = await res.json().catch(() => null)
    if (res.ok && d?.ok) return { ok: true, items: d.items }
    return { ok: false, reason: d?.reason || `http-${res.status}` }
  } catch {
    return { ok: false, reason: 'network' }
  }
}
