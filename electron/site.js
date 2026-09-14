/**
 * 官网与联系方式 —— **单一事实源**（2026-09-14，「官网联系」A 方案）
 *
 * 之前的问题不是"没有"，而是**多处各写一份、有的地方压根没有**：
 *   · `GatewayQuotaCard` 里硬编码 `const SERVICE_WECHAT = 'juncheng-service'`，
 *     上面还留着「TODO(上线前): 替换为真实客服微信号」；
 *   · `ActivationPage` 让客户「联系客服微信获取激活码」，却**一个号码都没给**；
 *   · 官网 / 文档站散在 `HelpPage` 里另写一遍。
 * ⇒ 换一次客服微信要改几个文件、重新打包发版。
 *
 * 现在：出厂默认带在版本里，**可被 `dataDir/site.json` 覆盖** ——
 * 换客服微信/电话只改这个文件（或在「设置 → 账户与支持」里直接改），**不用重新发版**。
 * 所有界面都从这一处读。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'site.json'
let dataDir = ''

/** 出厂默认。改这里 = 换整批新装的默认；改 site.json = 只换这台机器（不发版） */
export const SITE_DEFAULTS = {
  site: 'https://junchengzn.com',
  docs: 'https://junchengzn.com/docs',
  wechat: 'juncheng-service',
  phone: '',
  email: '',
}

const KEYS = Object.keys(SITE_DEFAULTS)

export function initSite(d) {
  dataDir = d
  try { fs.mkdirSync(dataDir, { recursive: true }) } catch { /* ignore */ }
}

function readOverride() {
  if (!dataDir) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8'))
    const out = {}
    for (const k of KEYS) if (typeof raw?.[k] === 'string' && raw[k].trim()) out[k] = raw[k].trim()
    return out
  } catch {
    return {}
  }
}

/** 当前生效的官网/联系方式（出厂默认 ← site.json 覆盖） */
export function getSiteContact() {
  const over = readOverride()
  return {
    ok: true,
    ...SITE_DEFAULTS,
    ...over,
    /** 本机 site.json 覆盖了哪些字段（界面可标注一下） */
    overridden: Object.keys(over),
    source: dataDir ? path.join(dataDir, FILE) : '',
  }
}

/** 只写白名单字段；传空串 = 恢复该字段的出厂默认 */
export function setSiteContact(patch = {}) {
  const cur = readOverride()
  for (const k of KEYS) {
    if (!(k in patch)) continue
    const v = String(patch[k] ?? '').trim()
    if (v) cur[k] = v
    else delete cur[k]
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, FILE), JSON.stringify(cur, null, 2) + '\n', 'utf8')
  } catch (e) {
    return { ok: false, error: '保存失败: ' + e.message }
  }
  return getSiteContact()
}
