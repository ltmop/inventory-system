// 功能开关（Feature Flag，P3 2026-09-15）
//
// 为什么要有它：**代码全量发到齐，功能用开关控制算不算数** —— 出事秒关，不用发版、不用热更。
// 三条腿里它最安全：热更换的是"跑什么代码"，开关只换"哪些代码算数"，而且**离线也能关**。
//
// 四层优先级（**这是本模块的核心语义，改之前先读三遍**）：
//   ① 服务端下发 "off"    ← 最高：能秒关全网；已缓存，所以离线也生效
//   ② 本机 flags.json     ← 店里自己说了算
//   ③ 服务端下发 "on"     ← 只是"建议打开"，本机可以否决
//   ④ 出厂默认（下面的 FLAG_DEFS）
// 一句话：**服务端能秒关一切，但不能替店里打开；本机自己说了算，除了"关"。**
// 之所以这样定：**"关"永远是安全方向，"开"永远有风险** —— 把"开"的权限交给远端，
// 等于把风险方向也交出去（远端一旦被改或写错，就会在店里打开一个没人验过的功能）。
//
// 铁律：
//   · 任何异常（文件坏、网络挂、JSON 烂、目录不存在）→ 一律退回出厂默认，**绝不抛、绝不砖机**
//   · 未登记的开关名一律**关**（fail-closed），并在状态里列出来 —— 不能出现"以为关了其实没关"
//   · 本机文件按 (mtime, size) 变化**热读** → 改完**不用重启**就生效（这就是"秒关"的本体）

import fs from 'node:fs'
import path from 'node:path'

const LOCAL_FILE = 'flags.json'
const REMOTE_FILE = 'flags-remote.json'
/** 服务端下发的开关对象（一个静态 JSON 就够，不需要改云服务代码） */
export const DEFAULT_REMOTE_URL = 'https://sync.junchengzn.com/flags/latest.json'
/** 自动去取服务端的节流：6 小时最多一次 */
export const REMOTE_TTL_MS = 6 * 3600 * 1000

/**
 * 出厂默认。**新增一个功能开关就在这里加一行**。
 * def 是"新装的机器默认算不算开"；改这里 = 换整批新装的默认（要发版）；
 * 改 dataDir/flags.json = 只换这台机器（不发版）；服务端下发 = 换一批机器（不发版）。
 */
export const FLAG_DEFS = {
  stockTransfer: { def: true, desc: '库位调拨（备货出库 / 换库位）' },
  aiBriefing: { def: true, desc: 'AI 经营简报' },
}

let dir = ''
let localCache = { key: '', values: {} }
let remoteCache = { fetchedAt: null, flags: {} }

const isBool = (v) => typeof v === 'boolean'

function localPath() { return dir ? path.join(dir, LOCAL_FILE) : '' }
function remotePath() { return dir ? path.join(dir, REMOTE_FILE) : '' }

/** 文件"变没变"的指纹：mtime + 大小（只比 mtime 在某些文件系统上会漏掉同毫秒内的修改） */
function fingerprint(f) {
  try {
    const st = fs.statSync(f)
    return st.mtimeMs + ':' + st.size
  } catch {
    return 'missing'
  }
}

function readLocal() {
  if (!dir) return {}
  const f = localPath()
  const key = fingerprint(f)
  if (key === localCache.key) return localCache.values
  let values = {}
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) if (isBool(v)) values[k] = v
    }
  } catch {
    // 坏文件/半截文件 = "没有本机覆盖"（按出厂默认继续跑），**不是**"把所有功能关掉"。
    // 后者会让一个手滑的编辑把整店功能锁死 —— 那才是真正的事故。
    values = {}
  }
  localCache = { key, values }
  return values
}

function readRemoteFile() {
  if (!dir) return { fetchedAt: null, flags: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(remotePath(), 'utf8'))
    const flags = {}
    if (raw && typeof raw === 'object' && raw.flags && typeof raw.flags === 'object') {
      for (const [k, v] of Object.entries(raw.flags)) if (isBool(v)) flags[k] = v
    }
    return { fetchedAt: typeof raw?.fetchedAt === 'string' ? raw.fetchedAt : null, flags }
  } catch {
    return { fetchedAt: null, flags: {} }
  }
}

function writeJsonAtomic(f, obj) {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, f)
}

/** 启动时调用一次（dataDir 就绪后立刻调，早于任何业务调用） */
export function initFlags(d) {
  dir = d || ''
  localCache = { key: '', values: {} } // 强制下次重读
  remoteCache = readRemoteFile()
  return flagStatus()
}

/** 这个开关现在算不算开。**未登记的名字一律 false**（fail-closed） */
export function isEnabled(name) {
  const def = FLAG_DEFS[name]
  if (!def) return false
  try {
    if (remoteCache.flags[name] === false) return false // ① 服务端关：压过一切
    const local = readLocal()
    if (Object.prototype.hasOwnProperty.call(local, name)) return local[name] === true // ② 本机说了算
    if (remoteCache.flags[name] === true) return true // ③ 服务端建议开
    return def.def === true // ④ 出厂默认
  } catch {
    return def.def === true // 读开关本身出错 → 按出厂默认（= 现在的行为），绝不因为读开关而崩
  }
}

/** 有效值是从哪一层来的（设置页要能说清"为什么算开/算关"） */
export function flagSource(name) {
  if (!FLAG_DEFS[name]) return 'unknown'
  if (remoteCache.flags[name] === false) return 'remote-off'
  if (Object.prototype.hasOwnProperty.call(readLocal(), name)) return 'local'
  if (remoteCache.flags[name] === true) return 'remote-on'
  return 'default'
}

/**
 * 改本机这一层。on: true/false 设定；**null = 删掉本机覆盖，恢复上级**。
 * 未知开关名直接拒绝（不让脏数据长进文件里）。
 */
export function setLocalFlag(name, on) {
  if (!FLAG_DEFS[name]) return { ok: false, error: `未知开关：${name}` }
  if (!dir) return { ok: false, error: '还没初始化（dataDir 为空）' }
  const cur = { ...readLocal() }
  if (on === null || on === undefined) delete cur[name]
  else cur[name] = on === true
  const clean = {}
  for (const k of Object.keys(FLAG_DEFS)) if (k in cur) clean[k] = cur[k]
  try {
    if (Object.keys(clean).length === 0) {
      // 本机这一层全恢复成"跟随上级"了 → 干脆不留文件。
      // 留一个 `{}` 会让人看不出"这台机器到底有没有本机覆盖"，而这件事直接影响排障。
      fs.rmSync(localPath(), { force: true })
    } else {
      writeJsonAtomic(localPath(), clean)
    }
  } catch (e) {
    return { ok: false, error: '保存失败: ' + e.message }
  }
  localCache = { key: '', values: {} } // 立刻失效缓存 → 下一次 isEnabled 就是新值（不用重启）
  return flagStatus()
}

/** 每个开关的有效值 + 来源 + 三层各是什么（界面据此显示，也能一眼看出"为什么没关掉"） */
export function flagStatus() {
  let local = {}
  try { local = readLocal() } catch { local = {} }
  const remote = remoteCache.flags || {}
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
  let flags = []
  try {
    flags = Object.keys(FLAG_DEFS).map((name) => ({
      name,
      desc: FLAG_DEFS[name].desc,
      def: FLAG_DEFS[name].def === true,
      on: isEnabled(name),
      source: flagSource(name),
      local: has(local, name) ? local[name] : null,
      remote: has(remote, name) ? remote[name] : null,
    }))
  } catch { flags = [] }
  const fetchedAt = remoteCache.fetchedAt
  const ageMs = fetchedAt ? Date.now() - Date.parse(fetchedAt) : null
  return {
    ok: true,
    flags,
    // 文件里"不认识"的键要报出来：否则会出现"以为关了其实没关"（名字打错是很常见的手滑）
    unknownLocal: Object.keys(local).filter((k) => !FLAG_DEFS[k]),
    unknownRemote: Object.keys(remote).filter((k) => !FLAG_DEFS[k]),
    remoteFetchedAt: fetchedAt,
    remoteAgeHours: Number.isFinite(ageMs) ? Math.round(ageMs / 3600000) : null,
    remoteUrl: process.env.FI_FLAGS_URL || DEFAULT_REMOTE_URL,
    localFile: localPath(),
    dir,
  }
}

/** 该不该去取服务端下发的开关（节流：默认 6 小时） */
export function shouldFetchRemote(ttlMs = REMOTE_TTL_MS) {
  const at = remoteCache.fetchedAt ? Date.parse(remoteCache.fetchedAt) : NaN
  if (!Number.isFinite(at)) return true
  return Date.now() - at >= ttlMs
}

/**
 * 取服务端下发的开关对象并落缓存。**任何失败都只返回原因，不改动现状、不抛异常**
 * —— 拉不到开关不是故障，它只是"没有新的远端意见"。
 * 允许 https:// 与本机回环（真机验证用）。
 */
export async function refreshRemoteFlags({ url, fetchImpl, timeoutMs = 8000 } = {}) {
  const f = fetchImpl || globalThis.fetch
  const u = String(url || process.env.FI_FLAGS_URL || DEFAULT_REMOTE_URL)
  if (!dir) return { ok: false, reason: '还没初始化（dataDir 为空）' }
  if (typeof f !== 'function') return { ok: false, reason: '本进程没有可用的 fetch' }
  if (!/^https:\/\//.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u)) {
    return { ok: false, reason: `只允许 https 下发地址：${u}` }
  }
  let raw
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await f(u, { signal: ctl.signal, cache: 'no-store' })
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`)
    raw = await res.json()
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, reason: `取开关失败：${(e && e.message) || e}` }
  }
  clearTimeout(timer)
  const flags = {}
  if (raw && typeof raw === 'object' && raw.flags && typeof raw.flags === 'object') {
    for (const [k, v] of Object.entries(raw.flags)) if (isBool(v)) flags[k] = v
  }
  const next = { fetchedAt: new Date().toISOString(), flags }
  try {
    writeJsonAtomic(remotePath(), next)
  } catch {
    // 写不进去就只在内存里生效：下次启动会丢，但本次会话仍然听服务端的
  }
  remoteCache = next
  return { ok: true, ...next, url: u }
}
