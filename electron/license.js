// 授权系统：Ed25519 非对称验签 + 三档版本（免费/进阶/大师）订阅制
// 铁律：try/catch 全部包裹，任何环节挂掉静默降级为 free 版——绝不阻断软件启动
// 公钥嵌客户端只验签，私钥只在老板的 scripts/gen-license.js 发码器里
// 配额：SKU/店/人按版本上限，商品创建在 commands 层经 enforceSkuQuota 强制拦截

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Ed25519 公钥（通用版独立密钥对，私钥在 scripts/license-private.pem）
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZF5JPtZwVsl6FfoSeNr0+VGQDewrcnEkZ6g90HXUnpM=
-----END PUBLIC KEY-----`

// 备用：如果找不到公钥文件，回退到内置公钥
const PUBLIC_KEY_FILE = path.join(os.homedir(), '.fishing-inventory', 'license-public.pem')

/** 三档版本配置：SKU/店/人 上限（v3.0 老板拍板） */
export const VERSION_PLAN = {
  free: { label: '普通版', sku: 300, stores: 1, users: 2 },
  pro: { label: '进阶版', sku: 1000, stores: 3, users: 10 },
  max: { label: '大师版', sku: Infinity, stores: Infinity, users: Infinity },
}

/** 版本枚举 */
export const LEVELS = ['free', 'pro', 'max']

/** 取某版本配额配置（非法等级回退 free） */
export function planFor(level) {
  return VERSION_PLAN[level] ?? VERSION_PLAN.free
}

/** 数据库 settings 表里镜像当前版本（key='license_level'），commands 层无需 dataDir 就能读版本做配额 */
export function readLevelFromDb(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'license_level'").get()
    const lv = row?.value
    return LEVELS.includes(lv) ? lv : 'free'
  } catch {
    return 'free'
  }
}

/** 把当前版本写入 db settings（激活/启动时同步） */
export function saveLevelToDb(db, level) {
  const lv = LEVELS.includes(level) ? level : 'free'
  try {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('license_level', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(lv)
  } catch {
    // 写不进不影响主流程（下次读回退 free 或启动再同步）
  }
}

/** SKU 配额强制：商品总数 + extra 超过当前版本上限则抛错（createProduct / importBatch 入口调用）。
 *  老库豁免：现有商品数已 ≥ 上限时不再拦截（老数据不卡死），等降到上限内才恢复限制。 */
export function enforceSkuQuota(db, extra = 1) {
  const level = readLevelFromDb(db)
  const plan = planFor(level)
  if (!Number.isFinite(plan.sku)) return // 大师版无限，不拦
  let count = 0
  try {
    count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n ?? 0
  } catch {
    return // 表异常不拦（兜底）
  }
  // 老库豁免：已超限的老用户允许继续用（不因降级/老数据被卡死）
  if (count >= plan.sku) return
  if (count + extra > plan.sku) {
    throw new Error(
      `当前为${plan.label}，最多 ${plan.sku} 个商品（已用 ${count}）。超限请升级${plan.label === '普通版' ? '进阶版或大师版' : '大师版'}。`,
    )
  }
}

/** 计算机器指纹：hostname + CPU 型号 + 网络 MAC → SHA256 前12位大写 */
export function machineFingerprint() {
  try {
    const parts = [
      os.hostname(),
      os.cpus()[0]?.model ?? 'unknown',
    ]
    const nets = os.networkInterfaces()
    for (const name of Object.keys(nets)) {
      for (const iface of nets[name] || []) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          parts.push(iface.mac.replace(/:/g, ''))
          break
        }
      }
    }
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12).toUpperCase()
  } catch {
    return 'UNKNOWN0000'
  }
}

/** 读取公钥（优先外部文件，可热升级） */
function loadPublicKey() {
  try {
    if (fs.existsSync(PUBLIC_KEY_FILE)) {
      return fs.readFileSync(PUBLIC_KEY_FILE, 'utf8')
    }
  } catch { /* 读不到文件用内置 */ }
  return PUBLIC_KEY_PEM
}

/** Ed25519 验签激活码是否有效；level 标记：P=Pro(进阶) M=Max(大师) */
export function verifyLicenseCode(code, machineId) {
  try {
    // 格式：ADU-FISH-{指纹前6位}-{到期日YYMMDD}-{等级(P/M)}-{Ed25519签名B64}
    const parts = code.split('-')
    if (parts.length < 6 || parts[0] !== 'ADU' || parts[1] !== 'FISH') {
      return { valid: false, error: '激活码格式不正确' }
    }

    const codeFingerprint = parts[2]
    const expireYYMMDD = parts[3]
    const levelChar = parts[4]
    const signatureB64 = parts.slice(5).join('-')

    if (codeFingerprint.toUpperCase() !== machineId.slice(0, 6)) {
      return { valid: false, error: '激活码与当前机器不匹配，请确认机器ID' }
    }

    const message = `ADU-FISH-${codeFingerprint}-${expireYYMMDD}-${levelChar}`
    const signature = Buffer.from(signatureB64, 'base64')

    const pubKey = loadPublicKey()
    const isValid = crypto.verify(null, Buffer.from(message), pubKey, signature)

    if (!isValid) {
      return { valid: false, error: '激活码无效' }
    }

    const yy = parseInt(expireYYMMDD.slice(0, 2), 10) + 2000
    const mm = parseInt(expireYYMMDD.slice(2, 4), 10) - 1
    const dd = parseInt(expireYYMMDD.slice(4, 6), 10)
    const expiresAt = new Date(yy, mm, dd, 23, 59, 59).toISOString()

    const level = levelChar === 'M' ? 'max' : 'pro'
    return { valid: true, level, expiresAt }
  } catch (e) {
    return { valid: false, error: e.message }
  }
}

const LICENSE_FILE = 'license.json'

/** 读取本地授权状态 */
export function loadLicense(dataDir) {
  const mid = machineFingerprint()
  try {
    const raw = fs.readFileSync(path.join(dataDir, LICENSE_FILE), 'utf8')
    const saved = JSON.parse(raw)
    const now = Date.now()
    const expiresAt = saved.expiresAt ? new Date(saved.expiresAt).getTime() : 0

    if (saved.machineId !== mid) {
      return { activated: false, level: 'free', expiresAt: null, machineId: mid, daysLeft: null }
    }

    if (now > expiresAt) {
      return { activated: false, level: 'free', expiresAt: saved.expiresAt, machineId: mid, daysLeft: 0 }
    }

    const daysLeft = Math.ceil((expiresAt - now) / (24 * 3600 * 1000))
    const level = LEVELS.includes(saved.level) ? saved.level : 'pro'
    return { activated: true, level, expiresAt: saved.expiresAt, machineId: mid, daysLeft }
  } catch {
    return { activated: false, level: 'free', expiresAt: null, machineId: mid, daysLeft: null }
  }
}

/** 激活授权（验签 + 写 license.json） */
export function activateLicense(dataDir, code) {
  const mid = machineFingerprint()
  const result = verifyLicenseCode(code, mid)

  if (!result.valid) {
    return { ok: false, error: result.error }
  }

  const license = {
    activated: true,
    level: result.level ?? 'pro',
    expiresAt: result.expiresAt ?? null,
    machineId: mid,
    daysLeft: null,
  }

  const now = Date.now()
  const exp = license.expiresAt ? new Date(license.expiresAt).getTime() : null
  license.daysLeft = exp ? Math.ceil((exp - now) / (24 * 3600 * 1000)) : null

  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, LICENSE_FILE), JSON.stringify(license), 'utf8')
    return { ok: true, license }
  } catch (e) {
    return { ok: false, error: `保存授权文件失败: ${e.message}` }
  }
}

/** 配额状态：当前版本 + 各配额使用量（SKU 真实统计；店/人先按单机默认，多店多员工功能接入后补真值） */
export function quotaStatus(db, dataDir) {
  const lic = loadLicense(dataDir)
  const level = lic.activated ? lic.level : 'free'
  const plan = planFor(level)
  let sku = 0
  try {
    sku = db.prepare('SELECT COUNT(*) AS n FROM products').get().n ?? 0
  } catch { /* 表异常按 0 */ }
  return {
    activated: lic.activated,
    level,
    plan,
    license: lic,
    usage: { sku, stores: 1, users: 1 },
    maxedOut: {
      sku: Number.isFinite(plan.sku) && sku >= plan.sku,
      stores: Number.isFinite(plan.stores) && 1 >= plan.stores,
      users: Number.isFinite(plan.users) && 1 >= plan.users,
    },
  }
}
