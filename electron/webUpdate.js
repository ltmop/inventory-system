// B 通道：业务层（dist）局部热更 + 四道护栏（P1，2026-09-15）
//
// 为什么要这条通道：桌面端「每次更新 = 退应用 + 装 124MB 整包 + 重启」，而那 124MB 里
// 业务层（dist 15.3MB + electron 1.1MB）只占约 11%，其余是几乎不变的 Electron 运行时与原生依赖。
// B 通道把这 11% 里的**前端部分**单独发、单独换：下载 → 逐文件校验 → 原子切换 → 下次启动生效。
//
// 四道护栏（缺一个都不上，逐条对应下面的函数）：
//   ① 逐文件 sha256 + 原子改名（installBundle）：任何失败保留旧目录，绝不半可用
//   ② 转正与回退（resolveWebRoot / markHealthy）：启动自检未获确认 → 下次启动自动退回上一版
//   ③ 只装业务层（validateManifest / isSafeRelPath）：路径必须落在目标目录内、后缀在白名单里、
//      总量有上限；并校验「热更包引用的通道 ⊆ 当前壳支持的通道」——不满足直接拒绝，
//      否则会重演 2026-09-14 那 62 个通道的静默失败（"点了没反应"）
//   ④ 用户可见（主进程发 webupdate:ready）：渲染层显示"新版本已就绪"，绝不静默替换
//
// 🔴 诚实边界：本期**没有做签名校验**。清单靠 HTTPS + 逐文件 sha256 保证**完整性**，
//    不保证**来源**。也就是说"能改到更新源的人 = 能改前端页面"。
//    这与手机线网页层热更的信任模型一致，但**不等于**安装包的签名强度。
//    撤下热更包的办法：删掉更新源上的 latest.json（客户端拿不到清单就不动，退化为现状）。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const WEB_DIR = 'web'
export const STATE_FILE = 'web-current.json'
export const VERSION_FILE = 'web-version.txt'
/** 清单地址（可用 FI_WEB_UPDATE_URL 覆盖；FI_NO_WEB_UPDATE=1 整条通道关闭） */
export const DEFAULT_MANIFEST_URL = 'https://sync.junchengzn.com/web/latest.json'

/** dist 里真实出现过的后缀（allowlist：比 denylist 明确，新增资源类型会**在发布侧**就报错而不是静默放行） */
export const ALLOWED_EXT = new Set([
  '.html', '.js', '.css', '.json', '.txt', '.webmanifest',
  '.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
])

const MAX_FILES = 400
const MAX_FILE_BYTES = 40 * 1024 * 1024
const MAX_TOTAL_BYTES = 80 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

/** 版本号数字比较（1.1.8.1 vs 1.1.8 这种不能被字符串比较糊弄过去）：a>b 返回正数 */
export function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

const isVersion = (v) => /^\d+(\.\d+){0,3}$/.test(String(v || '').trim())

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 护栏③之一：清单里的相对路径必须**只能**落在目标目录内。
 * 拦的是真实存在的几种越界写法：`../` 跳出、绝对路径、Windows 盘符/ADS（`C:`、`f.txt:ads`）、
 * 反斜杠混用、空段、超长名。返回 null 表示不合法（调用方把 null 当拒绝理由）。
 */
export function isSafeRelPath(rel) {
  const s = String(rel ?? '')
  if (!s || s.length > 200) return null
  if (s.includes('\0')) return null
  if (s.includes('\\')) return null // 统一用 /，混用反斜杠是 Windows 上绕过校验的常见手法
  if (s.includes(':')) return null // 盘符 C: 或 NTFS 数据流 file.txt:ads
  if (s.startsWith('/')) return null
  const segs = s.split('/')
  if (segs.some((x) => x === '' || x === '.' || x === '..')) return null
  const ext = path.extname(segs[segs.length - 1]).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) return null
  return s
}

/** 目标绝对路径必须真的在 baseDir 里面（与 isSafeRelPath 互为双保险） */
export function isInside(baseDir, absPath) {
  const base = path.resolve(baseDir)
  const abs = path.resolve(absPath)
  return abs === base || abs.startsWith(base + path.sep)
}

/**
 * 当前壳**真正**支持的通道集合 = 两条链路并集：
 *   ① preload 白名单：本机 IPC（本机模式下**所有**调用都过这道闸门，它就是运行时真值）；
 *   ② server.js 的路由：中心库/局域网模式下走 HTTP 的通道（**不过** preload，所以必须单独算进来）。
 * ⚠️ 只算 preload 是错的：`backup:list` 这类"故意留在服务端"的通道不在 preload 里，
 *    只看 preload 会把**每一个**热更包都判成"用到不支持的通道"而永久拒收（本闸门第一版就是这么错的）。
 */
export function readSupportedChannels(preloadPath, serverPath) {
  const out = new Set()
  try {
    const src = fs.readFileSync(preloadPath, 'utf8')
    const block = src.split('const CHANNELS = new Set([')[1]?.split('])')[0] ?? ''
    for (const m of block.matchAll(/'([a-zA-Z]+:[A-Za-z]+)'/g)) out.add(m[1])
  } catch { /* 读不到就当空集，调用方会拒绝一切 —— 宁可不动 */ }
  if (serverPath) {
    try {
      const srv = fs.readFileSync(serverPath, 'utf8')
      // 服务端路由写成 `'/api/...': () => ...` 与通道分发里的 `'channel':`，取键名
      for (const m of srv.matchAll(/'([a-zA-Z]+:[A-Za-z]+)'\s*:/g)) out.add(m[1])
    } catch { /* 忽略 */ }
  }
  return out
}

/** 内置前端的版本号（public/web-version.txt 会随构建进 dist）；读不到就退回壳版本 */
export function readBuiltinWebVersion(builtinDir, shellVersion) {
  try {
    const v = fs.readFileSync(path.join(builtinDir, VERSION_FILE), 'utf8').trim()
    if (isVersion(v)) return v
  } catch { /* 老包没有这个文件：退回壳版本 */ }
  return String(shellVersion || '0.0.0')
}

/**
 * 护栏③：清单校验。全部通过才返回 { ok:true, files }，否则 { ok:false, reason }（理由是给人看的）。
 * 这一条在**发布侧也会用同一个函数**（build-web-bundle.mjs），所以"能发布出去"与"客户端肯收"是同一套判据。
 */
export function validateManifest(manifest, opts = {}) {
  const { shellVersion = '0.0.0', currentWebVersion = '0.0.0', supportedChannels = null } = opts
  const reject = (reason) => ({ ok: false, reason })
  if (!manifest || typeof manifest !== 'object') return reject('清单不是对象')

  const webVersion = String(manifest.webVersion ?? '').trim()
  if (!isVersion(webVersion)) return reject(`webVersion 不合法：${webVersion || '(空)'}`)
  const minShellVersion = String(manifest.minShellVersion ?? '').trim()
  if (!isVersion(minShellVersion)) return reject(`minShellVersion 不合法：${minShellVersion || '(空)'}`)
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return reject('files 为空')
  if (manifest.files.length > MAX_FILES) return reject(`文件数 ${manifest.files.length} 超过上限 ${MAX_FILES}`)

  // 下载地址必须**以版本号结尾**：清单在 /web/latest.json，文件在 /web/<版本>/**
  // ⚠️ 这一次是真机验证抓到的：baseUrl 少了 /<版本>/ 这一层，清单本身校验通过、
  //    但**每一个文件**都会 404 —— 属于"闸门放行、装的时候全废"的那类静默故障。
  //    所以把它变成硬拦：写错就在校验阶段红，而不是等下载。
  if (manifest.baseUrl !== undefined) {
    const bu = String(manifest.baseUrl ?? '')
    if (!bu) return reject('baseUrl 为空（不写就用清单同级的 <版本>/ 目录）')
    const tail = bu.replace(/\/+$/, '').split('/').pop()
    if (tail !== webVersion) {
      return reject(`baseUrl 必须以版本号结尾：当前「${bu}」，应为 .../${webVersion}/`)
    }
  }

  // 版本方向：只允许往前走（防"回滚包"被当成更新推下来）
  if (cmpVersion(webVersion, currentWebVersion) <= 0) {
    return reject(`不是更新的版本：清单 ${webVersion} ≤ 当前 ${currentWebVersion}`)
  }
  // 壳兼容：热更包声明的 minShellVersion 必须 ≤ 当前壳
  if (cmpVersion(shellVersion, minShellVersion) < 0) {
    return reject(`需要壳版本 ≥ ${minShellVersion}，当前 ${shellVersion}（否则会用到壳不支持的通道）`)
  }

  const seen = new Set()
  const files = []
  let total = 0
  for (const f of manifest.files) {
    const rel = isSafeRelPath(f?.path)
    if (!rel) return reject(`非法路径：${String(f?.path ?? '')}`)
    if (seen.has(rel)) return reject(`重复路径：${rel}`)
    seen.add(rel)
    const size = Number(f?.size)
    if (!Number.isFinite(size) || size < 0) return reject(`${rel} 的 size 不合法`)
    if (size > MAX_FILE_BYTES) return reject(`${rel} 单文件 ${size} 字节超过上限`)
    const sha = String(f?.sha256 ?? '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(sha)) return reject(`${rel} 的 sha256 不是 64 位十六进制`)
    total += size
    if (total > MAX_TOTAL_BYTES) return reject(`总大小超过上限 ${MAX_TOTAL_BYTES} 字节`)
    files.push({ path: rel, size, sha256: sha })
  }
  // 入口必须在：没有 index.html 的热更包装上去就是白屏
  if (!seen.has('index.html')) return reject('缺少入口 index.html')

  // 通道子集：热更包引用的通道必须是当前壳**真的**支持的（否则用户看到"点了没反应"）
  let channels = []
  if (manifest.channels !== undefined) {
    if (!Array.isArray(manifest.channels)) return reject('channels 不是数组')
    channels = manifest.channels.map((c) => String(c ?? ''))
    for (const c of channels) {
      if (!/^[a-zA-Z]+:[A-Za-z]+$/.test(c)) return reject(`通道名不合法：${c || '(空)'}`)
    }
    if (supportedChannels) {
      const missing = channels.filter((c) => !supportedChannels.has(c)).sort()
      if (missing.length) return reject(`热更包用到当前壳不支持的通道：${missing.join(' ')}`)
    }
  }
  return { ok: true, webVersion, minShellVersion, files, channels, totalBytes: total }
}

// ---------- 状态文件（只存指针，不存内容） ----------

function statePath(dataDir) {
  return path.join(dataDir, STATE_FILE)
}

export function readWebState(dataDir) {
  const empty = { current: null, previous: null, attemptedAt: null, confirmedAt: null, lastRollback: null, lastError: null }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'))
    if (!raw || typeof raw !== 'object') return empty
    return { ...empty, ...raw }
  } catch {
    return empty // 坏文件按"没有热更"处理：退回内置，不制造新故障面
  }
}

export function writeWebState(dataDir, state) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const f = statePath(dataDir)
    const tmp = f + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, f)
    return true
  } catch {
    return false // 写不进去只影响"下次启动用哪版"，不影响本次运行
  }
}

const entry = (dir, webVersion, minShellVersion, indexSha256) => ({ dir, webVersion, minShellVersion, indexSha256 })

/**
 * 热更目录必须**真的能用**才认：入口存在 + 入口内容与安装时记下的 sha256 一致。
 * 这一条就是护栏②里"版本号正确"的可验证版本 —— 比比版本号更硬：
 * 它能发现"磁盘损坏 / 半截替换 / 被人手改过"这类版本号看不出来的坏。
 */
function hotDirUsable(dataDir, e) {
  if (!e || typeof e.dir !== 'string' || !e.dir) return false
  const abs = path.join(dataDir, e.dir)
  if (!isInside(path.join(dataDir, WEB_DIR), abs)) return false
  const indexFile = path.join(abs, 'index.html')
  if (!fs.existsSync(indexFile)) return false
  if (e.indexSha256) {
    try {
      if (sha256Hex(fs.readFileSync(indexFile)) !== e.indexSha256) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 护栏②（前半）：决定**这次启动**用哪个前端目录，并落"尝试"标记。
 * 返回值给 main.js 同时喂 `loadFile` 与 `webRoot`（只改一处 = 桌面看新版、手机看旧版）。
 *
 * 回退规则：上次启动记了 attemptedAt 却始终没等到健康确认（confirmedAt 为空）
 * → 说明那版**没能正常渲染** → 这次直接退回上一版，并把原因记进 lastRollback。
 */
export function resolveWebRoot({ dataDir, builtinDir, shellVersion }) {
  const builtinVersion = readBuiltinWebVersion(builtinDir, shellVersion)
  let state = readWebState(dataDir)
  const now = new Date().toISOString()
  let rolledBack = null
  let changed = false

  if (state.attemptedAt && !state.confirmedAt && state.current) {
    rolledBack = { webVersion: state.current.webVersion, at: now, reason: '上次启动未通过渲染自检' }
    state = { ...state, current: state.previous, previous: null, attemptedAt: null, confirmedAt: now, lastRollback: rolledBack }
    changed = true
  }

  const useHot =
    hotDirUsable(dataDir, state.current) &&
    cmpVersion(state.current.webVersion, builtinVersion) > 0 &&
    cmpVersion(shellVersion, state.current.minShellVersion || '0') >= 0

  if (!useHot) {
    // 指针指向的版本不再比内置新（或目录已损坏）→ 弃用，回内置。
    // 这一条防的是"装完新壳后，旧热更包还盖在上面"（桌面新、实际跑旧的）。
    if (state.current && cmpVersion(state.current.webVersion, builtinVersion) <= 0) {
      state = { ...state, current: null, previous: null, attemptedAt: null, confirmedAt: now, lastRollback: { webVersion: state.current.webVersion, at: now, reason: '内置版本已更新，弃用热更包' } }
      changed = true
    }
    // ⚠️ 回退也必须落盘：不落盘的话 attemptedAt 还挂着，**每次启动都会再回退一次**，
    //    而且界面永远拿不到 lastRollback（没法解释"我怎么变回旧版了"）。本闸门抓到过这个 bug。
    if (changed) writeWebState(dataDir, state)
    return { root: builtinDir, source: 'builtin', webVersion: builtinVersion, builtinVersion, rolledBack, state }
  }

  state = { ...state, attemptedAt: now, confirmedAt: null }
  writeWebState(dataDir, state)
  return {
    root: path.join(dataDir, state.current.dir),
    source: 'hot',
    webVersion: state.current.webVersion,
    builtinVersion,
    rolledBack,
    state,
  }
}

/** 护栏②（后半）：渲染自检通过 → 转正（清掉"未确认"状态，下次启动不再回退） */
export function markHealthy(dataDir, source = 'preload') {
  const state = readWebState(dataDir)
  if (!state.current) return { ok: false, reason: '当前没有热更版本' }
  if (state.confirmedAt) return { ok: true, already: true, webVersion: state.current.webVersion }
  const next = { ...state, confirmedAt: new Date().toISOString(), lastError: null }
  writeWebState(dataDir, next)
  return { ok: true, webVersion: state.current.webVersion, source }
}

/** 自检失败/页面报错时记一笔（**不立刻回退**：本次会话照常跑，回退发生在下次启动） */
export function markUnhealthy(dataDir, error) {
  const state = readWebState(dataDir)
  if (!state.current || state.confirmedAt) return { ok: false }
  const next = { ...state, lastError: String(error || '').slice(0, 300) }
  writeWebState(dataDir, next)
  return { ok: true }
}

// ---------- 下载与安装 ----------

const joinUrl = (base, rel) => String(base).replace(/\/+$/, '') + '/' + rel.replace(/^\/+/, '')

/** 只允许 https://；另放行 http://127.0.0.1 与 http://localhost（本机验证用，写在这里是有意的） */
export function isAllowedSource(baseUrl) {
  const u = String(baseUrl || '')
  if (u.startsWith('https://')) return true
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u)) return true
  return false
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, cache: 'no-store' })
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 省流量的一级来源：**本地已有的同内容文件直接复制，不下载**。
 * 比对的是"当前正在用的那份热更包"与"安装包内置的 dist" —— 它们在收银机上本来就存在。
 * ⚠️ 必须验 sha256 才算数：本地文件可能损坏/被人改过，拿它当"一样"会把坏文件带进新版本。
 */
function tryReuse(dirs, f) {
  for (const d of dirs) {
    if (!d) continue
    try {
      const abs = path.join(d, ...f.path.split('/'))
      if (!isInside(d, abs)) continue
      if (fs.statSync(abs).size !== f.size) continue
      const buf = fs.readFileSync(abs)
      if (sha256Hex(buf) !== f.sha256) continue
      return buf
    } catch { /* 这一处没有/读不了，继续找下一处 */ }
  }
  return null
}

/**
 * 护栏①：逐文件下载到 `<版本>.tmp/` → 每个文件都验 sha256 与 size → 全部通过才原子改名。
 * 任何一步失败：删掉 .tmp，正式目录与指针**原样不动**（宁可没有热更，也不要半可用）。
 * reuseDirs：可以本地复用的目录（当前热更包 / 内置 dist）——纯 UI 改动通常只需下几个文件。
 */
export async function installBundle({ manifest, baseUrl, dataDir, fetchImpl, onProgress, reuseDirs = [] }) {
  const v = String(manifest.webVersion)
  const targetDir = path.join(dataDir, WEB_DIR, v)
  const tmpDir = targetDir + '.tmp'
  const files = manifest.files

  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  let done = 0
  let bytes = 0 // 真正从网络下来的字节
  let reused = 0 // 本地复制、没走网络的文件数
  let reusedBytes = 0
  try {
    for (const f of files) {
      const abs = path.join(tmpDir, ...f.path.split('/'))
      if (!isInside(tmpDir, abs)) throw new Error(`路径越界：${f.path}`)
      let buf = tryReuse(reuseDirs, f)
      if (buf) {
        reused++
        reusedBytes += buf.byteLength
      } else {
        const res = await fetchImpl(joinUrl(baseUrl, f.path), { cache: 'no-store' })
        if (!res || !res.ok) throw new Error(`${f.path} 下载失败 HTTP ${res ? res.status : '?'}`)
        buf = Buffer.from(await res.arrayBuffer())
        if (buf.byteLength !== f.size) throw new Error(`${f.path} 大小不符：${buf.byteLength} ≠ ${f.size}`)
        if (sha256Hex(buf) !== f.sha256) throw new Error(`${f.path} sha256 校验失败`)
        bytes += buf.byteLength
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, buf)
      done++
      try {
        onProgress?.({ done, total: files.length, percent: Math.round((done / files.length) * 100), bytes, reused, reusedBytes })
      } catch { /* 回调出错不影响安装 */ }
    }
    // 原子换目录：先清掉可能存在的同名半成品，再改名（Windows 下 rename 不覆盖已存在目录）
    fs.rmSync(targetDir, { recursive: true, force: true })
    fs.renameSync(tmpDir, targetDir)
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw e
  }

  // 指针切到新版本：attemptedAt 留空 → 下次启动才记"尝试"，那时开始等健康确认
  const state = readWebState(dataDir)
  const relDir = path.join(WEB_DIR, v)
  const indexSha256 = files.find((x) => x.path === 'index.html')?.sha256 || ''
  const next = {
    ...state,
    current: entry(relDir, v, String(manifest.minShellVersion), indexSha256),
    previous: state.current && state.current.webVersion !== v ? state.current : state.previous,
    attemptedAt: null,
    confirmedAt: null, // 还没转正：下次启动若没等到健康确认就自动回退
    lastError: null,
  }
  writeWebState(dataDir, next)
  return { ok: true, webVersion: v, files: done, bytes, reused, reusedBytes, dir: targetDir }
}

/**
 * 完整流程：取清单 → 校验 → 安装。**任何失败都只返回结果，不抛异常**（挂掉 = 没有热更，不是打不开）。
 * 这一步只负责"把新前端准备好"，生效在下次启动 —— 收银机在营业中不会被换掉页面。
 */
export async function checkAndStage({ dataDir, manifestUrl, shellVersion, builtinDir, supportedChannels, fetchImpl, onProgress }) {
  const f = fetchImpl || globalThis.fetch
  const url = String(manifestUrl || DEFAULT_MANIFEST_URL)
  if (process.env.FI_NO_WEB_UPDATE === '1') return { ok: false, reason: '本机已关闭热更（FI_NO_WEB_UPDATE=1）' }
  if (!isAllowedSource(url)) return { ok: false, reason: `只允许 https 更新源：${url}` }
  if (typeof f !== 'function') return { ok: false, reason: '本进程没有可用的 fetch' }

  let manifest
  try {
    manifest = await fetchJson(url, f, FETCH_TIMEOUT_MS)
  } catch (e) {
    return { ok: false, reason: `取清单失败：${(e && e.message) || e}` }
  }
  const currentWebVersion = readBuiltinWebVersion(builtinDir, shellVersion)
  const state = readWebState(dataDir)
  const current = state.current?.webVersion || currentWebVersion
  const v = validateManifest(manifest, { shellVersion, currentWebVersion: current, supportedChannels })
  if (!v.ok) return { ok: false, reason: `清单被拒：${v.reason}` }

  // 不写 baseUrl 就按约定推导：清单同级目录下的 <版本>/（与文件实际摆放一致）
  const baseUrl = manifest.baseUrl || url.replace(/\/[^/]*$/, '/') + v.webVersion + '/'
  if (!isAllowedSource(baseUrl)) return { ok: false, reason: `只允许 https 下载地址：${baseUrl}` }
  try {
    // 本地可复用的三处：当前正在用的热更包、上一版热更包、安装包内置的 dist
    const reuseDirs = [
      state.current?.dir ? path.join(dataDir, state.current.dir) : null,
      state.previous?.dir ? path.join(dataDir, state.previous.dir) : null,
      builtinDir,
    ].filter(Boolean)
    const r = await installBundle({ manifest, baseUrl, dataDir, fetchImpl: f, onProgress, reuseDirs })
    const saved = r.reusedBytes > 0 ? `，其中 ${r.reused} 个文件本地已有、省下 ${(r.reusedBytes / 1048576).toFixed(1)} MB` : ''
    return { ok: true, staged: true, reason: `已就绪 v${r.webVersion}（下次启动生效${saved}）`, ...r }
  } catch (e) {
    return { ok: false, reason: `安装失败（已回滚，旧版本未受影响）：${(e && e.message) || e}` }
  }
}

/** 给界面看的当前状态（不含任何路径以外的敏感信息） */
export function webUpdateStatus(dataDir, resolved) {
  const state = readWebState(dataDir)
  return {
    source: resolved?.source ?? 'builtin',
    webVersion: resolved?.webVersion ?? '',
    builtinVersion: resolved?.builtinVersion ?? '',
    ready: state.current && !state.confirmedAt ? { webVersion: state.current.webVersion, dir: state.current.dir } : null,
    lastRollback: state.lastRollback || null,
    lastError: state.lastError || null,
    manifestUrl: process.env.FI_WEB_UPDATE_URL || DEFAULT_MANIFEST_URL,
    disabled: process.env.FI_NO_WEB_UPDATE === '1',
  }
}
