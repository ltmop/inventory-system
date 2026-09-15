// 业务层局部热更：B 通道（前端 dist）+ C 通道（口径层 electron/commands）（P1/P2，2026-09-15）
//
// 为什么要这两条通道：桌面端「每次更新 = 退应用 + 装 124MB 整包 + 重启」，而那 124MB 里
// 业务层（dist 15.3MB + electron 1.1MB）只占约 11%，其余是几乎不变的 Electron 运行时与原生依赖。
//
//   B 通道（dist）      ：秒级生效，收银机营业中只提示、不换页面
//   C 通道（口径层）    ：改的是**主进程里的代码**，必须重启进程才生效（约 2 秒，不是重装）
//                       实测闭包 35 个文件 / 208 KB，只依赖 Node 内置，**零 `import electron`**
//
// 四道护栏（缺一个都不上，逐条对应下面的函数）：
//   ① 逐文件 sha256 + 原子改名（installBundle）：任何失败保留旧目录，绝不半可用
//   ② 转正与回退（resolveWebRoot / markHealthy）：启动自检未获确认 → 下次启动自动退回上一版
//   ③ 只装业务层（validateManifest / isSafeRelPath）：路径必须落在目标目录内、后缀在白名单里、
//      总量有上限；并校验「热更包引用的通道 ⊆ 当前壳支持的通道」——不满足直接拒绝，
//      否则会重演 2026-09-14 那 62 个通道的静默失败（"点了没反应"）
//   ④ 用户可见（主进程发 webupdate:ready）：渲染层显示"新版本已就绪"，绝不静默替换
//
// C 通道另有三条**它独有**的护栏（因为它是在主进程执行代码，比页面层危险一档）：
//   C1 绝不砖机：口径层在**启动时**被 import，任何加载失败都必须静默回退内置（见 commandsLive.js）
//   C2 出口集合校验：热更的 barrel 必须**导出内置 barrel 的全部名字**（缺一个就整包拒用），
//      这条专拦"发布时打歪了/漏文件"这类一半新一半旧的病
//   C3 单入口：全仓库只有 commandsLive.js 允许 import 命令层（闸门 check:webupdate 会断言）
//
// 🔴 诚实边界：**两条通道都没有签名校验**。清单靠 HTTPS + 逐文件 sha256 保证**完整性**，
//    不保证**来源**。B 通道改的是沙箱里的页面（受 preload 通道白名单约束）；
//    **C 通道改的是主进程代码 —— 能改到更新源的人就能在这台机器上执行任意代码**。
//    这与手机线网页层热更的信任模型一致，但**不等于**安装包的签名强度。
//    撤下热更包的办法：删掉更新源上的 latest.json（客户端拿不到清单就不动，退化为现状）。
//    想在某台机器上永久关掉：环境变量 FI_NO_WEB_UPDATE=1，或删 dataDir/web-current.json。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const WEB_DIR = 'web'
/** C 通道目录：`electron/` 的一个子树镜像（commands.js + commands/** + 它的相对依赖） */
export const CODE_DIR = 'code'
export const STATE_FILE = 'web-current.json'
export const VERSION_FILE = 'web-version.txt'
/** C 通道三个入口（相对 code 根目录）：barrel + 两个被运行时**直接**引用的模块 */
export const CODE_ENTRIES = { commands: 'commands.js', search: 'commands/search.js', analytics: 'commands/analytics.js' }
/** 有它才叫一个能用的口径层包 */
export const CODE_ROOT_FILE = 'commands.js'
/**
 * 清单地址（可用 FI_WEB_UPDATE_URL 覆盖；FI_NO_WEB_UPDATE=1 整条通道关闭）
 *
 * ⚠️ 为什么是 `/updates/web/` 而不是看着更整齐的 `/web/`：2026-09-15 上生产机核对过 ——
 *    `sync.junchengzn.com` 在 Caddy 里是 `reverse_proxy 127.0.0.1:3100`（inventory-cloud 这个 Node 服务），
 *    **没有** `/web/` 或 `/flags/` 路由；而 `/updates/*` 已经有现成的静态托管
 *    （`STATIC_ROOT = index.js 所在目录 = /opt/inventory-cloud/`，任意后缀、支持 Range、GET/HEAD 都认）。
 *    所以把热更包与开关下发放在 `/updates/` 下面 = **零服务端代码改动、不用重启生产**。
 *    写 `/web/` 的话会 404 —— 而且是"清单取不到 → 静默没有热更"这种最难发现的失败。
 */
export const DEFAULT_MANIFEST_URL = 'https://sync.junchengzn.com/updates/web/latest.json'

/** dist 里真实出现过的后缀（allowlist：比 denylist 明确，新增资源类型会**在发布侧**就报错而不是静默放行） */
export const ALLOWED_EXT = new Set([
  '.html', '.js', '.css', '.json', '.txt', '.webmanifest',
  '.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
])
/** C 通道只收纯 JS（口径层不 import electron，也正因如此才能单独热更） */
export const CODE_ALLOWED_EXT = new Set(['.js'])

const MAX_FILES = 400
const MAX_FILE_BYTES = 40 * 1024 * 1024
const MAX_TOTAL_BYTES = 80 * 1024 * 1024
/** 口径层实测 208 KB / 35 个文件；上限给足余量，但拦住"打包打歪了" */
const MAX_CODE_FILES = 200
const MAX_CODE_TOTAL_BYTES = 8 * 1024 * 1024
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
export function isSafeRelPath(rel, allowedExt = ALLOWED_EXT) {
  const s = String(rel ?? '')
  if (!s || s.length > 200) return null
  if (s.includes('\0')) return null
  if (s.includes('\\')) return null // 统一用 /，混用反斜杠是 Windows 上绕过校验的常见手法
  if (s.includes(':')) return null // 盘符 C: 或 NTFS 数据流 file.txt:ads
  if (s.startsWith('/')) return null
  const segs = s.split('/')
  if (segs.some((x) => x === '' || x === '.' || x === '..')) return null
  const ext = path.extname(segs[segs.length - 1]).toLowerCase()
  if (!allowedExt.has(ext)) return null
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

  // ---------- C 通道（口径层）文件集：可选，但写了就必须完整 ----------
  // ⚠️ 只收 .js（CODE_ALLOWED_EXT）—— 于是 `package.json` 天然进不来：
  //    热更目录的 {"type":"module"} 由**客户端自己生成**，绝不让清单来决定模块解析方式。
  const codeFiles = []
  let codeBytes = 0
  if (manifest.codeFiles !== undefined) {
    if (!Array.isArray(manifest.codeFiles) || manifest.codeFiles.length === 0) {
      return reject('codeFiles 不是非空数组（不带口径层就别写这个字段）')
    }
    if (manifest.codeFiles.length > MAX_CODE_FILES) {
      return reject(`口径层文件数 ${manifest.codeFiles.length} 超过上限 ${MAX_CODE_FILES}`)
    }
    const seenCode = new Set()
    for (const f of manifest.codeFiles) {
      const rel = isSafeRelPath(f?.path, CODE_ALLOWED_EXT)
      if (!rel) return reject(`非法口径层路径：${String(f?.path ?? '')}`)
      if (seenCode.has(rel)) return reject(`重复口径层路径：${rel}`)
      seenCode.add(rel)
      const size = Number(f?.size)
      if (!Number.isFinite(size) || size < 0) return reject(`${rel} 的 size 不合法`)
      const sha = String(f?.sha256 ?? '').trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(sha)) return reject(`${rel} 的 sha256 不是 64 位十六进制`)
      codeBytes += size
      if (codeBytes > MAX_CODE_TOTAL_BYTES) return reject(`口径层总大小超过上限 ${MAX_CODE_TOTAL_BYTES} 字节`)
      codeFiles.push({ path: rel, size, sha256: sha })
    }
    // 三个入口一个都不能少：少了 barrel 就用不了；少了 search/analytics 会出现
    // "一半走热更、一半走内置" —— 正是这个项目一直在治的口径分叉
    for (const e of [CODE_ROOT_FILE, ...Object.values(CODE_ENTRIES)]) {
      if (!seenCode.has(e)) return reject(`口径层缺少入口 ${e}`)
    }
  }

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
  return { ok: true, webVersion, minShellVersion, files, channels, totalBytes: total, codeFiles, codeBytes }
}

// ---------- 状态文件（只存指针，不存内容） ----------

function statePath(dataDir) {
  return path.join(dataDir, STATE_FILE)
}

export function readWebState(dataDir) {
  const empty = { current: null, previous: null, attemptedAt: null, confirmedAt: null, lastRollback: null, lastError: null, lastCodeError: null, lastCodeErrorAt: null }
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

// ---------- C 通道（口径层）：目录判定 / 作废 / 加载 ----------

/** 口径层目录必须真的能用：三个入口都在 + 入口内容与安装时记下的 sha256 一致 */
function codeDirUsable(dataDir, e) {
  if (!e || typeof e.codeDir !== 'string' || !e.codeDir) return false
  const abs = path.join(dataDir, e.codeDir)
  if (!isInside(path.join(dataDir, CODE_DIR), abs)) return false
  for (const rel of [CODE_ROOT_FILE, ...Object.values(CODE_ENTRIES)]) {
    if (!fs.existsSync(path.join(abs, ...rel.split('/')))) return false
  }
  const entryFile = path.join(abs, CODE_ROOT_FILE)
  if (e.codeEntrySha256) {
    try {
      if (sha256Hex(fs.readFileSync(entryFile)) !== e.codeEntrySha256) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 决定这次启动要不要用热更的口径层 → 返回它的绝对目录（不用就是 null）。
 *
 * ⚠️ 它**必须独立**判断，不能复用 resolveWebRoot 的结果：commandsLive.js 是在**模块加载时**
 *    （top-level await）就把口径层 import 进来的，而 resolveWebRoot 跑在 `app.whenReady()` 里 ——
 *    顺序是反的。所以这里自己读状态，但规则与 resolveWebRoot 保持一致
 *    （尤其"上次记了尝试却没转正 → 这次先回内置"）。
 *
 * 版本基线用**壳版本**：内置口径层的版本就等于壳版本，所以壳涨上去（如 1.1.9）以后，
 * 旧热更口径层（1.1.8.1）会自动弃用，不需要人工清理。
 */
export function resolveCodeDir({ dataDir, shellVersion }) {
  const state = readWebState(dataDir)
  const e = state.current
  if (!e || !e.codeDir) return null
  if (state.attemptedAt && !state.confirmedAt) return null // 上次没转正：这次先用内置
  if (!codeDirUsable(dataDir, e)) return null
  if (cmpVersion(e.webVersion, String(shellVersion || '0')) <= 0) return null
  if (cmpVersion(String(shellVersion || '0'), e.minShellVersion || '0') < 0) return null
  return path.join(dataDir, e.codeDir)
}

/**
 * 口径层加载失败时把它作废 —— **必须落盘**：不落盘的话每次启动都会再试一次、每次都失败。
 * 只作废口径层，页面层不受影响（页面对了、代码错了，就只退代码这一层）。
 */
export function abandonHotCode(dataDir, reason) {
  const state = readWebState(dataDir)
  if (!state.current?.codeDir) return { ok: false }
  const next = {
    ...state,
    current: { ...state.current, codeDir: null, codeEntrySha256: '' },
    // ⚠️ 用**独立的字段**记口径层的错：曾经写进 lastError，结果被 markHealthy 清成 null
    //    （页面自检通过时会清 lastError）→ owner 永远看不到"口径层为什么没用"。真机验证抓到的。
    lastCodeError: `口径层已放弃：${String(reason || '').slice(0, 200)}`,
    lastCodeErrorAt: new Date().toISOString(),
  }
  writeWebState(dataDir, next)
  return { ok: true, reason: String(reason || '') }
}

/**
 * 护栏 C1+C2：挑口径层模块。热更的每个入口必须**导出内置的全部名字**（缺一个就整包拒用）。
 *   · C1 绝不砖机：这里**从不抛异常**，任何失败都返回内置模块 —— 口径层坏了顶多是"没热更"，不是打不开
 *   · C2 出口集合：专拦"发布时打歪了/漏了文件"这类"一半新一半旧"，它比彻底坏掉更难查
 * importFn 可注入（闸门里用假的），默认用真的动态 import。
 */
export async function pickCodeModule({ hotDir, entries = CODE_ENTRIES, builtins, importFn }) {
  const doImport = importFn || ((u) => import(u))
  const modules = { ...builtins }
  if (!hotDir) return { source: 'builtin', modules, error: null }
  try {
    const hot = {}
    for (const [k, rel] of Object.entries(entries)) {
      hot[k] = await doImport(pathToFileURL(path.join(hotDir, ...rel.split('/'))).href)
    }
    for (const [k, builtinNs] of Object.entries(builtins)) {
      const missing = Object.keys(builtinNs).filter((n) => !(n in (hot[k] || {})))
      if (missing.length) {
        return {
          source: 'builtin',
          modules,
          error: `热更口径层 ${entries[k] || k} 少了 ${missing.length} 个导出（如 ${missing.slice(0, 5).join(', ')}）`,
        }
      }
    }
    return { source: 'hot', modules: hot, error: null }
  } catch (e) {
    return { source: 'builtin', modules, error: `热更口径层加载失败：${(e && e.message) || e}` }
  }
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
 * 护栏①：把两个部分**都**准备到各自的 `<版本>.tmp/` → 每个文件验 sha256 与 size →
 * **两边都通过**才分别原子改名。任何一步失败：删掉两个 .tmp，正式目录与指针原样不动
 * （"页面是新的、代码是旧的"这种半成品最难查，所以宁可整包不要）。
 * reuseDirs / reuseCodeDirs：可以本地复用的目录（上一版 / 内置）——纯 UI 改动通常只需下几个文件。
 * manifest 不带 codeFiles 时的语义：**口径层回内置**（用来单独撤掉一个坏的口径层）。
 */
export async function installBundle({ manifest, baseUrl, dataDir, fetchImpl, onProgress, reuseDirs = [], reuseCodeDirs = [] }) {
  const v = String(manifest.webVersion)
  const webTarget = path.join(dataDir, WEB_DIR, v)
  const webTmp = webTarget + '.tmp'
  const codeTarget = path.join(dataDir, CODE_DIR, v)
  const codeTmp = codeTarget + '.tmp'
  const webFiles = manifest.files
  const codeFiles = Array.isArray(manifest.codeFiles) ? manifest.codeFiles : []
  const total = webFiles.length + codeFiles.length

  fs.rmSync(webTmp, { recursive: true, force: true })
  fs.rmSync(codeTmp, { recursive: true, force: true })
  fs.mkdirSync(webTmp, { recursive: true })

  let done = 0
  let bytes = 0 // 真正从网络下来的字节
  let reused = 0 // 本地复制、没走网络的文件数
  let reusedBytes = 0

  const one = async (tmpDir, reuseSources, f) => {
    const abs = path.join(tmpDir, ...f.path.split('/'))
    if (!isInside(tmpDir, abs)) throw new Error(`路径越界：${f.path}`)
    let buf = tryReuse(reuseSources, f)
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
      onProgress?.({ done, total, percent: Math.round((done / total) * 100), bytes, reused, reusedBytes })
    } catch { /* 回调出错不影响安装 */ }
  }

  try {
    for (const f of webFiles) await one(webTmp, reuseDirs, f)
    if (codeFiles.length) {
      fs.mkdirSync(codeTmp, { recursive: true })
      for (const f of codeFiles) await one(codeTmp, reuseCodeDirs, f)
      // ⚠️ 这一行是 C 通道能不能跑起来的关键：热更目录在 %APPDATA% 下，**祖先目录里没有 package.json**，
      //    于是 .js 会被 Node 当成 CommonJS，而口径层用的是 ESM 语法 → import 直接 SyntaxError。
      //    由客户端自己生成（而不是从清单里下载）也就顺带堵死了"让更新源决定模块解析方式"。
      fs.writeFileSync(path.join(codeTmp, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
    }
    // 两边都准备好了才动正式目录
    fs.rmSync(webTarget, { recursive: true, force: true })
    fs.renameSync(webTmp, webTarget)
    if (codeFiles.length) {
      fs.rmSync(codeTarget, { recursive: true, force: true })
      fs.renameSync(codeTmp, codeTarget)
    }
  } catch (e) {
    fs.rmSync(webTmp, { recursive: true, force: true })
    fs.rmSync(codeTmp, { recursive: true, force: true })
    throw e
  }

  // 指针切到新版本：attemptedAt 留空 → 下次启动才记"尝试"，那时开始等健康确认
  const state = readWebState(dataDir)
  const relDir = path.join(WEB_DIR, v)
  const indexSha256 = webFiles.find((x) => x.path === 'index.html')?.sha256 || ''
  const next = {
    ...state,
    current: {
      ...entry(relDir, v, String(manifest.minShellVersion), indexSha256),
      codeDir: codeFiles.length ? path.join(CODE_DIR, v) : null,
      codeEntrySha256: codeFiles.find((x) => x.path === CODE_ROOT_FILE)?.sha256 || '',
    },
    previous: state.current && state.current.webVersion !== v ? state.current : state.previous,
    attemptedAt: null,
    confirmedAt: null, // 还没转正：下次启动若没等到健康确认就自动回退
    lastError: null,
  }
  writeWebState(dataDir, next)
  return {
    ok: true,
    webVersion: v,
    files: done,
    bytes,
    reused,
    reusedBytes,
    dir: webTarget,
    codeDir: codeFiles.length ? codeTarget : null,
    codeFiles: codeFiles.length,
  }
}

/**
 * 完整流程：取清单 → 校验 → 安装。**任何失败都只返回结果，不抛异常**（挂掉 = 没有热更，不是打不开）。
 * 这一步只负责"把新前端准备好"，生效在下次启动 —— 收银机在营业中不会被换掉页面。
 */
export async function checkAndStage({ dataDir, manifestUrl, shellVersion, builtinDir, builtinCodeDir, supportedChannels, fetchImpl, onProgress }) {
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
    // 本地可复用的几处：当前正在用的热更包、上一版热更包、安装包内置的 dist / electron
    const reuseDirs = [
      state.current?.dir ? path.join(dataDir, state.current.dir) : null,
      state.previous?.dir ? path.join(dataDir, state.previous.dir) : null,
      builtinDir,
    ].filter(Boolean)
    const reuseCodeDirs = [
      state.current?.codeDir ? path.join(dataDir, state.current.codeDir) : null,
      state.previous?.codeDir ? path.join(dataDir, state.previous.codeDir) : null,
      builtinCodeDir,
    ].filter(Boolean)
    const r = await installBundle({ manifest, baseUrl, dataDir, fetchImpl: f, onProgress, reuseDirs, reuseCodeDirs })
    const saved = r.reusedBytes > 0 ? `，其中 ${r.reused} 个文件本地已有、省下 ${(r.reusedBytes / 1048576).toFixed(1)} MB` : ''
    const code = r.codeFiles ? `；口径层 ${r.codeFiles} 个文件（重启后生效）` : '；口径层回内置'
    return { ok: true, staged: true, reason: `已就绪 v${r.webVersion}（下次启动生效${saved}）${code}`, ...r }
  } catch (e) {
    return { ok: false, reason: `安装失败（已回滚，旧版本未受影响）：${(e && e.message) || e}` }
  }
}

/** 给界面看的当前状态（不含任何路径以外的敏感信息） */
export function webUpdateStatus(dataDir, resolved, codeInfo) {
  const state = readWebState(dataDir)
  return {
    source: resolved?.source ?? 'builtin',
    webVersion: resolved?.webVersion ?? '',
    builtinVersion: resolved?.builtinVersion ?? '',
    ready: state.current && !state.confirmedAt ? { webVersion: state.current.webVersion, dir: state.current.dir } : null,
    lastRollback: state.lastRollback || null,
    lastError: state.lastError || null,
    // C 通道（口径层）：这次启动到底用的是热更那份还是内置那份，以及为什么没用
    codeSource: codeInfo?.source ?? 'builtin',
    codeError: codeInfo?.error ?? null,
    // 上一次被放弃的原因（存活在状态文件里，不会被页面自检的"清错误"清掉）
    lastCodeError: state.lastCodeError || null,
    lastCodeErrorAt: state.lastCodeErrorAt || null,
    codePending: !!(state.current?.codeDir && !state.confirmedAt),
    manifestUrl: process.env.FI_WEB_UPDATE_URL || DEFAULT_MANIFEST_URL,
    disabled: process.env.FI_NO_WEB_UPDATE === '1',
  }
}
