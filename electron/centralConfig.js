// 中心库连接配置的**主进程单一事实源**（P0，2026-09-15）
//
// 为什么要有它：
//   配置原本只存在渲染层 localStorage（`fi-central-url` / `fi-central-token`）。
//   2026-09-15 实测：Electron 43 + sandbox + file:// 下，localStorage **跨目录共享** ——
//   也就是说将来把前端热更到别的目录，**不会**因此丢配置（这一条比预想的安全）。但仍有两个真实隐患：
//     ① 换存储机制 / 改自定义协议加载 / 用户清站点数据 → 静默退回本地模式（= 看错账，最难发现的那种错）；
//     ② 主进程那道「整库上传闸门」用的是 `central-mode.json`（渲染层上报），
//        与渲染层真正用的 localStorage 配置**可能漂移** —— 一旦漂移，闸门挡的就不是真正的模式。
//
// 现在的分工（单一事实源 + 容错）：
//   · 文件 `dataDir/central.json` 是事实源，主进程启动即读，并用它**自己**决定闸门开关；
//   · preload 在页面脚本之前把**缺失的** localStorage 补齐（只补缺失，不覆盖当次修改）；
//   · 渲染层仍读写 localStorage（不改现有代码路径），变更时通过 `cloud:setCentralMode` 回写文件。
//
// 🔴 铁律：**这个文件里绝不允许打印 token**（与 start-central.mjs 那次日志泄露同一类教训）。

import fs from 'node:fs'
import path from 'node:path'

const FILE = 'central.json'
let dir = null
let cache = { url: '', token: '' }

const normalize = ({ url, token } = {}) => {
  const u = String(url ?? '').trim().replace(/\/+$/, '')
  const t = String(token ?? '').trim()
  // 半截配置一律当成"没配"（与 cloud.js 的 saveLocalConfig 同一铁律：宁可当没配，也不留半截）
  return u && t ? { url: u, token: t } : { url: '', token: '' }
}

function readFile() {
  try {
    if (!dir) return { url: '', token: '' }
    const f = path.join(dir, FILE)
    if (!fs.existsSync(f)) return { url: '', token: '' }
    return normalize(JSON.parse(fs.readFileSync(f, 'utf8')))
  } catch {
    return { url: '', token: '' } // 坏文件按"没配"处理，不制造新故障面
  }
}

/** 启动时调用（dataDir 就绪后立刻调，早于任何同步动作） */
export function initCentralConfig(dataDir) {
  dir = dataDir
  cache = readFile()
  return getCentralConfigLocal()
}

/** 当前配置（只返回 url/token 两个字段，别把整个对象丢出去） */
export function getCentralConfigLocal() {
  return { url: cache.url, token: cache.token }
}

export function isCentralConfigured() {
  return !!(cache.url && cache.token)
}

/** 写入（原子替换：先写 .tmp 再 rename，断电不会留半截 JSON）；0600 只给本用户读 */
export function setCentralConfigLocal(patch = {}) {
  const next = normalize({ url: patch.url ?? cache.url, token: patch.token ?? cache.token })
  cache = next
  try {
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, FILE)
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, f)
  } catch {
    // 写不进去就只在内存里生效：不阻断任何功能，下次启动会由渲染层再报一次
  }
  return { ok: true, url: next.url, token: next.token }
}
