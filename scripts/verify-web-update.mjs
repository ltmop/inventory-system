// 业务层局部热更闸门：npm run check:webupdate
//
// B 通道（前端）+ C 通道（口径层）。这个闸门跟前面那些"读源码找关键字"的不一样：
// 它**真的把护栏跑一遍** —— 在系统临时目录里造假的内置包与假的更新源（内存假 fetch），
// 验证：正常安装能成、每种坏包都被拒、坏包不留残留、没通过自检会回退、回退有界、
// **口径层真的能被 ESM 加载起来**、加载失败绝不砖机。全程不碰网络、不碰 %APPDATA%、不碰生产。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  installBundle, validateManifest, resolveWebRoot, markHealthy, readWebState, writeWebState,
  isSafeRelPath, isAllowedSource, readSupportedChannels, readBuiltinWebVersion,
  sha256Hex, cmpVersion, ALLOWED_EXT,
  resolveCodeDir, abandonHotCode, pickCodeModule, CODE_ENTRIES, CODE_ROOT_FILE, CODE_ALLOWED_EXT,
} from '../electron/webUpdate.js'
import { computeCodeClosure } from './lib/code-closure.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')) }
}

// ---------- 测试脚手架 ----------
const tmpRoots = []
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fi-webupd-'))
  tmpRoots.push(dir)
  const dataDir = path.join(dir, 'data')
  const builtinDir = path.join(dir, 'builtin')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(path.join(builtinDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(builtinDir, 'index.html'), '<div id="root"></div><script src="assets/app.js"></script>')
  fs.writeFileSync(path.join(builtinDir, 'assets', 'app.js'), '// builtin 1.1.8.0')
  fs.writeFileSync(path.join(builtinDir, 'web-version.txt'), '1.1.8.0')
  return { dir, dataDir, builtinDir }
}

/** 造一个"包"：返回 { manifest, source }，source 是 URL→Buffer 的内存文件表 */
function makeBundle(webVersion, opts = {}) {
  const body = opts.body ?? `<div id="root"></div><script src="assets/app.js"></script><!-- ${webVersion} -->`
  const js = opts.js ?? `// hot ${webVersion}`
  const files = [
    { path: 'index.html', buf: Buffer.from(body) },
    { path: 'assets/app.js', buf: Buffer.from(js) },
    ...(opts.extra ?? []),
  ]
  const source = {}
  for (const f of files) source[f.path] = f.buf
  const manifest = {
    webVersion,
    minShellVersion: opts.minShellVersion ?? '1.1.8',
    baseUrl: `https://sync.junchengzn.com/web/${webVersion}/`,
    channels: opts.channels ?? [A_CHANNEL],
    files: files.map((f) => ({
      path: f.path,
      size: opts.badSizeOn === f.path ? f.buf.byteLength + 1 : f.buf.byteLength,
      sha256: opts.badShaOn === f.path ? 'f'.repeat(64) : sha256Hex(f.buf),
    })),
  }
  // 可选的口径层（C 通道）：文件与前端共用一个 base URL，所以合进同一张 source 表
  if (opts.code) {
    manifest.codeFiles = opts.code.entries
    Object.assign(source, opts.code.source)
  }
  return { manifest, source }
}

/**
 * 造一个最小的"口径层包"：三个入口各导出一个可调用函数。
 * 用最小的假包（而不是真命令层）是为了：① 闸门不执行真实业务代码；② 能精确构造坏包。
 */
function makeCodeBundle(opts = {}) {
  const files = {
    'commands.js': `export function alpha() { return '${opts.alpha ?? 'a'}' }\n`,
    'commands/search.js': `export function beta() { return 'b' }\n`,
    'commands/analytics.js': `export function gamma() { return 'g' }\n`,
  }
  if (opts.breakSyntax) files['commands.js'] = 'export function alpha( {\n'
  if (opts.extra) Object.assign(files, opts.extra)
  if (opts.drop) for (const d of opts.drop) delete files[d]
  const source = {}
  const entries = []
  for (const [p, body] of Object.entries(files)) {
    const buf = Buffer.from(body)
    source[p] = buf
    entries.push({ path: p, size: buf.byteLength, sha256: sha256Hex(buf) })
  }
  return { source, entries }
}
/** 闸门里用的假"内置口径层"：三个入口各有一个导出 */
const FAKE_BUILTINS = () => ({
  commands: { alpha() { return 'builtin' } },
  search: { beta() { return 'builtin' } },
  analytics: { gamma() { return 'builtin' } },
})

const MANIFEST_URL = 'https://sync.junchengzn.com/web/latest.json'
/** 文件地址形如 /web/<版本>/<路径>：去掉 base 前缀就是包内相对路径 */
const stripBase = (u) => String(u).replace(/^https:\/\/sync\.junchengzn\.com\/web\/[^/]+\//, '')
function makeFetch(source, manifest) {
  const hit = []
  const f = async (url) => {
    hit.push(String(url))
    let buf = null
    if (String(url) === MANIFEST_URL && manifest) buf = Buffer.from(JSON.stringify(manifest))
    else if (source[stripBase(url)] !== undefined) buf = source[stripBase(url)]
    if (buf === null) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => new Uint8Array(buf).buffer }
  }
  f.hit = hit
  return f
}

const SHELL = '1.1.8'
const supported = readSupportedChannels(path.join(REPO, 'electron', 'preload.cjs'), path.join(REPO, 'electron', 'server.js'))
// 测试包默认用一个**壳真的支持**的通道（第一版这里用了 product:list —— 它只在 server.js 里，
// 结果每个测试包都被判成"通道不兼容"，闸门自己先红了。这条断言就是把那个坑钉住）
const A_CHANNEL = 'product:create'
ok('壳能力集包含测试用的通道', supported.has(A_CHANNEL), [...supported].slice(0, 5).join(' '))

console.log('=== ① 护栏①：逐文件 sha256 + 原子改名（任何失败保留旧目录）===')
{
  const { dataDir, builtinDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1')
  const f = makeFetch(source, manifest)
  const r = await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: f })
  ok('正常包：安装成功', r.ok && r.files === 2, JSON.stringify(r))
  ok('正常包：文件真的落到 <版本> 目录里', fs.readFileSync(path.join(dataDir, 'web', '1.1.8.1', 'index.html'), 'utf8').includes('1.1.8.1'))
  ok('正常包：不留 .tmp 半成品', !fs.existsSync(path.join(dataDir, 'web', '1.1.8.1.tmp')))
  ok('正常包：指针写下了版本号与入口 sha256',
    readWebState(dataDir).current?.webVersion === '1.1.8.1' && /^[0-9a-f]{64}$/.test(readWebState(dataDir).current?.indexSha256 || ''))
  ok('正常包：还没转正（confirmedAt 为空，等下次启动自检）',
    readWebState(dataDir).confirmedAt === null && readWebState(dataDir).attemptedAt === null)
}
for (const [label, opts] of [
  ['sha256 不符', { badShaOn: 'assets/app.js' }],
  ['大小不符', { badSizeOn: 'index.html' }],
]) {
  const { dataDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1', opts)
  let threw = ''
  try { await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: makeFetch(source, manifest) }) } catch (e) { threw = e.message }
  ok(`坏包（${label}）：拒绝安装并说明原因`, /校验失败|大小不符/.test(threw), threw)
  ok(`坏包（${label}）：不留 .tmp 残留`, !fs.existsSync(path.join(dataDir, 'web', '1.1.8.1.tmp')))
  ok(`坏包（${label}）：不留下半截正式目录`, !fs.existsSync(path.join(dataDir, 'web', '1.1.8.1')))
  ok(`坏包（${label}）：指针没被改动（退回内置，不是半可用）`, readWebState(dataDir).current === null)
}
{
  // 半路 404：第一个文件成功、第二个失败 —— 必须整包回滚
  const { dataDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1')
  delete source['assets/app.js']
  let threw = ''
  try { await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: makeFetch(source, manifest) }) } catch (e) { threw = e.message }
  ok('坏包（第二个文件 404）：整包回滚，不留部分文件',
    /下载失败/.test(threw) && !fs.existsSync(path.join(dataDir, 'web', '1.1.8.1')) && !fs.existsSync(path.join(dataDir, 'web', '1.1.8.1.tmp')), threw)
}

console.log('\n=== ② 护栏③：清单校验（路径 / 后缀 / 版本方向 / 壳兼容 / 通道子集）===')
const V = (files, extra = {}) => validateManifest(
  { webVersion: '1.1.8.1', minShellVersion: '1.1.8', files, ...extra },
  { shellVersion: SHELL, currentWebVersion: '1.1.8.0', supportedChannels: supported },
)
const F = (p, o = {}) => ({ path: p, size: 10, sha256: 'a'.repeat(64), ...o })
const good = [F('index.html'), F('assets/app.js')]
ok('合法清单通过', V(good).ok)
for (const [label, p] of [
  ['../ 跳出', '../evil.js'],
  ['绝对路径', '/etc/passwd.js'],
  ['盘符', 'C:/x.js'],
  ['反斜杠混用', 'assets\\app.js'],
  ['空段', 'assets//app.js'],
  ['当前目录段', './index.js'],
  ['NTFS 数据流', 'index.html:evil.js'],
  ['超出深度跳出', 'assets/../../x.js'],
]) {
  const r = V([F('index.html'), F(p)])
  ok(`清单校验拒绝「${label}」：${p}`, !r.ok && /非法路径/.test(r.reason), r.reason)
}
for (const [label, p] of [['可执行文件', 'assets/a.exe'], ['原生模块', 'assets/a.node'], ['主进程文件', 'preload.cjs'], ['语音模型', 'assets/m.onnx']]) {
  const r = V([F('index.html'), F(p)])
  ok(`清单校验拒绝「${label}」：${p}`, !r.ok && /非法路径/.test(r.reason), r.reason)
}
ok('清单校验拒绝：缺入口 index.html', !V([F('assets/app.js')]).ok)
ok('清单校验拒绝：重复路径', !V([F('index.html'), F('index.html')]).ok)
ok('清单校验拒绝：sha256 不是 64 位十六进制', !V([F('index.html'), F('a.js', { sha256: 'zz' })]).ok)
ok('清单校验拒绝：单文件超上限', !V([F('index.html'), F('a.js', { size: 999 * 1024 * 1024 })]).ok)
ok('清单校验拒绝：版本没往前走（防回滚包被当更新推下来）', !V(good, { webVersion: '1.1.8.0' }).ok)
ok('清单校验拒绝：壳太老（minShellVersion 高于当前壳）', !V(good, { minShellVersion: '1.1.9' }).ok)
{
  const r = validateManifest(
    { webVersion: '1.1.8.1', minShellVersion: '1.1.8', files: good, channels: ['product:list', 'made:upChannel'] },
    { shellVersion: SHELL, currentWebVersion: '1.1.8.0', supportedChannels: supported },
  )
  ok('清单校验拒绝：用到壳不支持的通道（防重演"点了没反应"）', !r.ok && /不支持的通道/.test(r.reason) && /made:upChannel/.test(r.reason), r.reason)
}
ok('清单校验拒绝：通道名格式不对', !V(good, { channels: ['nocolon'] }).ok)
{
  // 真机验证抓到的坑：baseUrl 少了 /<版本>/ 这一层，清单校验照样通过，
  // 但**每一个文件**都 404（"闸门放行、装的时候全废"）。现在硬拦。
  const r = V(good, { baseUrl: 'https://sync.junchengzn.com/web/' })
  ok('清单校验拒绝：baseUrl 少了版本段（否则每个文件都会 404）', !r.ok && /版本号结尾/.test(r.reason), r.reason)
  ok('清单接受：baseUrl 以版本号结尾', V(good, { baseUrl: 'https://sync.junchengzn.com/web/1.1.8.1/' }).ok)
  ok('清单接受：不写 baseUrl（客户端按约定推导）', V(good).ok)
}

console.log('\n=== ③ 护栏②：转正与回退（没通过自检 → 下次启动退回，且回退有界）===')
{
  const { dataDir, builtinDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1')
  await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: makeFetch(source, manifest) })

  const L1 = resolveWebRoot({ dataDir, builtinDir, shellVersion: SHELL })
  ok('第一次启动：用热更版', L1.source === 'hot' && L1.webVersion === '1.1.8.1' && L1.root.includes('1.1.8.1'))
  ok('第一次启动：内置版本号读得出来（1.1.8.0）', L1.builtinVersion === '1.1.8.0', L1.builtinVersion)
  ok('第一次启动：记下"尝试中"', !!readWebState(dataDir).attemptedAt && !readWebState(dataDir).confirmedAt)

  const L2 = resolveWebRoot({ dataDir, builtinDir, shellVersion: SHELL })
  ok('第二次启动（上次没等到健康确认）：自动回退', !!L2.rolledBack && /自检/.test(L2.rolledBack.reason))
  ok('第二次启动：退回的是内置版（没有上一版可退时）', L2.source === 'builtin' && L2.root === builtinDir)
  ok('第二次启动：回退原因写进状态（界面能解释"我怎么变回旧版了"）', !!readWebState(dataDir).lastRollback)
}
{
  const { dataDir, builtinDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1')
  await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: makeFetch(source, manifest) })
  resolveWebRoot({ dataDir, builtinDir, shellVersion: SHELL })
  const h = markHealthy(dataDir)
  ok('自检通过：转正（写下 confirmedAt）', h.ok && !!readWebState(dataDir).confirmedAt)
  const L = resolveWebRoot({ dataDir, builtinDir, shellVersion: SHELL })
  ok('自检通过后：下次启动继续用热更版，不再回退', L.source === 'hot' && !L.rolledBack)
  ok('自检通过后：attemptedAt 重新记（为下一次故障留后路）', !!readWebState(dataDir).attemptedAt)
}
{
  // 有上一版可退：A 成功后装 B，B 没通过自检 → 退回 A（而不是一路退回内置）
  const { dataDir, builtinDir } = workspace()
  const A = makeBundle('1.1.8.1')
  await installBundle({ manifest: A.manifest, baseUrl: A.manifest.baseUrl, dataDir, fetchImpl: makeFetch(A.source, A.manifest) })
  resolveWebRoot({ dataDir, builtinDir, shellVersion: SHELL })
  markHealthy(dataDir)
  const B = makeBundle('1.1.8.2')
  await installBundle({ manifest: B.manifest, baseUrl: B.manifest.baseUrl, dataDir, fetchImpl: makeFetch(B.source, B.manifest) })
  const LB = resolveWebRoot({ dataDir, builtinDir, shellVersion: SHELL })
  ok('装 B 后启动：用 B', LB.source === 'hot' && LB.webVersion === '1.1.8.2')
  const LR = resolveWebRoot({ dataDir, builtinDir, shellVersion: SHELL })
  ok('B 没通过自检：退回 A（上一版），不是一路退到内置', LR.rolledBack?.webVersion === '1.1.8.2' && LR.webVersion === '1.1.8.1', `${LR.rolledBack?.webVersion} / ${LR.webVersion}`)
  const LR2 = resolveWebRoot({ dataDir, builtinDir, shellVersion: SHELL })
  ok('A 也没通过自检：再退一步到内置（回退有界，不会无限循环）', LR2.source === 'builtin' && LR2.root === builtinDir)
}
{
  const { dataDir, builtinDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1')
  await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: makeFetch(source, manifest) })
  markHealthy(dataDir)
  // 装完新壳：内置前端版本涨到 1.1.8.2 > 热更包 1.1.8.1
  fs.writeFileSync(path.join(builtinDir, 'web-version.txt'), '1.1.8.2')
  const L = resolveWebRoot({ dataDir, builtinDir, shellVersion: SHELL })
  ok('装完更新的壳：弃用旧热更包，回内置（防"壳是新的、跑的却是旧前端"）',
    L.source === 'builtin' && /内置版本已更新/.test(readWebState(dataDir).lastRollback?.reason || ''), readWebState(dataDir).lastRollback?.reason)
}
{
  const { dataDir, builtinDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1')
  await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: makeFetch(source, manifest) })
  markHealthy(dataDir)
  // 入口文件被改坏（磁盘损坏/人手改过）：sha256 对不上 → 不能用
  fs.writeFileSync(path.join(dataDir, 'web', '1.1.8.1', 'index.html'), '<div>tampered</div>')
  const L = resolveWebRoot({ dataDir, builtinDir, shellVersion: SHELL })
  ok('入口文件内容对不上（"版本号正确"的可验证版本）：拒绝加载，回内置', L.source === 'builtin')
}

console.log('\n=== ④ 只允许 https（本机回环除外）===')
ok('https 放行', isAllowedSource('https://sync.junchengzn.com/web/'))
ok('明文 http 被拒（否则热更可被中间人换掉）', !isAllowedSource('http://sync.junchengzn.com/web/'))
ok('任意 http 主机被拒', !isAllowedSource('http://evil.example/web/'))
ok('本机回环放行（真机验证要用）', isAllowedSource('http://127.0.0.1:18999/web/') && isAllowedSource('http://localhost:18999/web/'))
ok('file:// 被拒', !isAllowedSource('file:///D:/web/'))

console.log('\n=== ⑤ 走完整流程（checkAndStage）：坏清单不进目录、好清单进目录 ===')
const { checkAndStage } = await import('../electron/webUpdate.js')
{
  const { dataDir, builtinDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1', { channels: ['made:upChannel'] })
  const r = await checkAndStage({
    dataDir, manifestUrl: MANIFEST_URL, shellVersion: SHELL, builtinDir, supportedChannels: supported,
    fetchImpl: makeFetch(source, manifest),
  })
  ok('通道不兼容的包：整条流程拒绝，且不落盘', !r.ok && /不支持的通道/.test(r.reason) && !fs.existsSync(path.join(dataDir, 'web', '1.1.8.1')), r.reason)
}
{
  const { dataDir, builtinDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1')
  const r = await checkAndStage({
    dataDir, manifestUrl: MANIFEST_URL, shellVersion: SHELL, builtinDir, supportedChannels: supported,
    fetchImpl: makeFetch(source, manifest),
  })
  ok('正常包：整条流程成功且写明"下次启动生效"', r.ok && r.staged && /下次启动生效/.test(r.reason), r.reason)
}
{
  const { dataDir, builtinDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1')
  delete manifest.baseUrl // 不写 baseUrl：按约定推导
  const f = makeFetch(source, manifest)
  const r = await checkAndStage({
    dataDir, manifestUrl: MANIFEST_URL, shellVersion: SHELL, builtinDir, supportedChannels: supported,
    fetchImpl: f,
  })
  ok('清单不写 baseUrl：按「清单同级/<版本>/」推导，文件 URL 真的带版本段',
    r.ok && f.hit.some((u) => u.includes('/web/1.1.8.1/index.html')), r.reason + ' | ' + f.hit.join(' ').slice(0, 200))
}
{
  const { dataDir, builtinDir } = workspace()
  const f = async () => { throw new Error('网络不通') }
  const r = await checkAndStage({ dataDir, manifestUrl: MANIFEST_URL, shellVersion: SHELL, builtinDir, supportedChannels: supported, fetchImpl: f })
  ok('更新源挂了：只返回失败原因，不抛异常（挂掉是"没有热更"，不是打不开）', !r.ok && /取清单失败/.test(r.reason), r.reason)
}
{
  const { dataDir, builtinDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1')
  const r = await checkAndStage({ dataDir, manifestUrl: 'http://evil.example/latest.json', shellVersion: SHELL, builtinDir, supportedChannels: supported, fetchImpl: makeFetch(source, manifest) })
  ok('非 https 更新源：整条流程拒绝', !r.ok && /只允许 https/.test(r.reason), r.reason)
}

console.log('\n=== ⑥ 接线：热更目录必须同时喂窗口与服务端（否则桌面新、手机旧）===')
const mainJs = read('electron/main.js')
const appTsx = read('src/App.tsx')
const banner = read('src/components/WebUpdateBanner.tsx')
const preloadSrc = read('electron/preload.cjs')
const apiTs = read('src/lib/api.ts')
ok('main.js 用 resolvedWeb.root 加载窗口（不再是写死的 ../dist）',
  /loadFile\(path\.join\(resolvedWeb\.root,\s*'index\.html'\)\)/.test(mainJs) && !/loadFile\(path\.join\(__dirname,\s*'\.\.\/dist'/.test(mainJs))
ok('main.js 把同一个 resolvedWeb.root 交给服务端 webRoot',
  /createInventoryServer\(\{[^}]*webRoot:\s*resolvedWeb\.root/.test(mainJs))
ok('main.js 在窗口与服务端**之前**就把目录定下来',
  mainJs.indexOf('resolvedWeb = resolveWebRoot(') < mainJs.indexOf('inventoryServer = createInventoryServer({'))
ok('main.js 传的是壳真值 app.getVersion()', /shellVersion:\s*app\.getVersion\(\)/.test(mainJs))
ok('main.js 的通道清单来自壳自己的文件（运行时那两道闸门就是唯一真值）',
  /supportedChannels:\s*readSupportedChannels\(path\.join\(__dirname,\s*'preload\.cjs'\),\s*path\.join\(__dirname,\s*'server\.js'\)\)/.test(mainJs))
// ⚠️ 这条是防"发布侧永久拒收一切"：如果能力集算法漏掉某一类通道（例如只在 server.js 里的
//    backup:list），那么每一个热更包都会被判成"通道不兼容"。本闸门第一版就真的踩了这个坑。
{
  const { channelsUsedInSrc } = await import('./lib/channels.mjs')
  const usedInSrc = [...channelsUsedInSrc(REPO)].sort()
  const uncovered = usedInSrc.filter((c) => !supported.has(c))
  ok(`壳能力集覆盖渲染层用到的全部 ${usedInSrc.length} 个通道（否则发布侧会拒收每一个包）`,
    uncovered.length === 0, uncovered.join(' '))
}
ok('main.js 启动就检查一次（静默、有节流）', /setTimeout\(\(\) => \{ runWebCheck\(\)/.test(mainJs) && /6 \* 3600 \* 1000/.test(mainJs))

console.log('\n=== ⑦ 护栏④：用户可见（不静默替换）===')
ok('主进程只在**装好之后**发"已就绪"事件', /if \(r\.staged\)[\s\S]{0,200}?webupdate:ready/.test(mainJs))
ok('preload 暴露订阅', preloadSrc.includes('onWebUpdateReady') && preloadSrc.includes("'webupdate:ready'"))
ok('横幅组件挂着（App.tsx 里真的有它）', /import \{ WebUpdateBanner \}/.test(appTsx) && /<WebUpdateBanner \/>/.test(appTsx))
ok('横幅把"立即生效"做成按钮（由人点，不自动重启）', /webupdate:restart/.test(banner) && /立即生效/.test(banner))
ok('横幅能解释"已自动退回上一版"', /已自动退回上一版/.test(banner) && /lastRollback/.test(banner))
ok('横幅也会说明口径层为什么没用（不是静默回内置）',
  /lastCodeError/.test(banner) && /口径层更新未启用/.test(banner))
ok('横幅不自动重启：组件里没有直接 relaunch/自动调用 restart',
  !/useEffect\([\s\S]{0,600}?applyNow\(\)/.test(banner))

console.log('\n=== ⑧ 通道归属（新通道必须归本机，否则中心库模式下 404）===')
for (const ch of ['webupdate:status', 'webupdate:check', 'webupdate:restart']) {
  ok(`${ch} 在 main.js 注册`, mainJs.includes(`'${ch}'`))
  ok(`${ch} 在 preload 放行`, preloadSrc.includes(`'${ch}'`))
  ok(`${ch} 在 LOCAL_ONLY_CHANNELS（不能靠 update: 前缀兜）`, apiTs.includes(`'${ch}'`))
}

console.log('\n=== ⑨ 护栏③的另一半：热更包**只装业务层** ===')
{
  const { dataDir, builtinDir } = workspace()
  const { manifest, source } = makeBundle('1.1.8.1')
  for (const f of manifest.files) ok(`包体只含白名单后缀：${f.path}`, ALLOWED_EXT.has(path.extname(f.path).toLowerCase()))
  ok('内置 dist 的版本号来自 dist/web-version.txt', readBuiltinWebVersion(builtinDir, 'x') === '1.1.8.0')
  ok('读不到 web-version.txt 时退回壳版本（老包也能跑）', readBuiltinWebVersion(path.join(dataDir, 'nope'), '1.1.8') === '1.1.8')
  ok('版本比较是数字比较：1.1.8.10 > 1.1.8.9', cmpVersion('1.1.8.10', '1.1.8.9') > 0)
  ok('路径安全函数本身不接受空/超长', isSafeRelPath('') === null && isSafeRelPath('a'.repeat(300) + '.js') === null)
}

console.log('\n=== ⑩ 省流量：本地已有的同内容文件不下载（逐文件比对，验过 sha256 才算）===')
{
  const { dataDir, builtinDir } = workspace()
  // 场景：只改了 index.html，assets/app.js 与内置 dist 一模一样（真实情况就是几个 JS/CSS 变、壁纸字体不变）
  const A = makeBundle('1.1.8.1', { js: '// builtin 1.1.8.0' })
  const fA = makeFetch(A.source, A.manifest)
  const rA = await checkAndStage({
    dataDir, manifestUrl: MANIFEST_URL, shellVersion: SHELL, builtinDir, supportedChannels: supported, fetchImpl: fA,
  })
  ok('没变的那个文件从内置 dist 直接复用，没走网络',
    rA.ok && rA.reused === 1 && !fA.hit.some((u) => u.endsWith('assets/app.js')), JSON.stringify(fA.hit))
  ok('省下的字节数是真的（等于那个文件的字节数）',
    rA.reusedBytes === Buffer.from('// builtin 1.1.8.0').byteLength, String(rA.reusedBytes))
  ok('结果里写明了省了多少（owner 能看懂为什么这次快）', /省下/.test(rA.reason), rA.reason)

  const B = makeBundle('1.1.8.2', { js: '// builtin 1.1.8.0' })
  const fB = makeFetch(B.source, B.manifest)
  const rB = await checkAndStage({
    dataDir, manifestUrl: MANIFEST_URL, shellVersion: SHELL, builtinDir, supportedChannels: supported, fetchImpl: fB,
  })
  ok('下一次更新：可以从"上一版热更包"复用（不只内置那一处）',
    rB.ok && rB.reused === 1 && !fB.hit.some((u) => u.endsWith('assets/app.js')), JSON.stringify(fB.hit))
}
{
  const { dataDir, builtinDir } = workspace()
  fs.writeFileSync(path.join(builtinDir, 'assets', 'app.js'), '// 被人手改坏了')
  const A = makeBundle('1.1.8.1', { js: '// builtin 1.1.8.0' })
  const fA = makeFetch(A.source, A.manifest)
  const rA = await checkAndStage({
    dataDir, manifestUrl: MANIFEST_URL, shellVersion: SHELL, builtinDir, supportedChannels: supported, fetchImpl: fA,
  })
  ok('本地那份内容对不上 → 不复用，老老实实下载（sha256 是唯一判据，防把坏文件带进新版）',
    rA.ok && rA.reused === 0 && fA.hit.some((u) => u.endsWith('assets/app.js')),
    JSON.stringify({ reused: rA.reused, hit: fA.hit }))
}

console.log('\n=== ⑪ C 通道（口径层）：清单校验 ===')
const CV = (code, extra = {}) => validateManifest(
  { webVersion: '1.1.8.1', minShellVersion: '1.1.8', files: good, ...(code === null ? {} : { codeFiles: code }), ...extra },
  { shellVersion: SHELL, currentWebVersion: '1.1.8.0', supportedChannels: supported },
)
{
  const code = makeCodeBundle().entries
  const r = CV(code)
  ok('合法口径层清单通过', r.ok, r.reason)
  ok('通过时把口径层文件数与字节数一并算出来（发布侧/界面要显示）',
    r.ok && r.codeFiles.length === 3 && r.codeBytes > 0, JSON.stringify({ n: r.ok ? r.codeFiles.length : -1 }))
  const noCode = CV(null)
  ok('不写 codeFiles：清单照样通过（语义 = 口径层回内置，也是"单独撤掉坏口径层"的办法）',
    noCode.ok && noCode.codeFiles.length === 0)
  ok('拒绝：codeFiles 是空数组', !CV([]).ok)
  ok('拒绝：codeFiles 不是数组', !CV('nope').ok)
  ok('拒绝：缺 barrel（commands.js）', !CV(makeCodeBundle({ drop: ['commands.js'] }).entries).ok)
  ok('拒绝：缺 search.js（否则一半走热更、一半走内置）', !CV(makeCodeBundle({ drop: ['commands/search.js'] }).entries).ok)
  ok('拒绝：缺 analytics.js', !CV(makeCodeBundle({ drop: ['commands/analytics.js'] }).entries).ok)
  ok('拒绝：package.json 混进来（模块解析方式不许由更新源决定）',
    !CV([...makeCodeBundle().entries, { path: 'package.json', size: 20, sha256: 'a'.repeat(64) }]).ok)
  ok('拒绝：非 .js（原生件 .node 不能进口径层）',
    !CV([...makeCodeBundle().entries, { path: 'x.node', size: 10, sha256: 'a'.repeat(64) }]).ok)
  ok('拒绝：路径越界（../）',
    !CV([...makeCodeBundle().entries, { path: '../evil.js', size: 10, sha256: 'a'.repeat(64) }]).ok)
  ok('拒绝：重复路径', !CV([...makeCodeBundle().entries, makeCodeBundle().entries[0]]).ok)
  ok('拒绝：sha256 不合法', !CV(makeCodeBundle().entries.map((e, i) => (i === 0 ? { ...e, sha256: 'zz' } : e))).ok)
  ok('拒绝：总大小超上限', !CV(makeCodeBundle().entries.map((e, i) => (i === 0 ? { ...e, size: 9 * 1024 * 1024 } : e))).ok)
}

console.log('\n=== ⑫ C 通道：安装 + **真实 ESM 加载**（证明生成的 package.json 真的让 import 生效）===')
{
  const { dataDir } = workspace()
  const code = makeCodeBundle({ alpha: 'HOT' })
  const { manifest, source } = makeBundle('1.1.8.1', { code })
  const f = makeFetch(source, manifest)
  const r = await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: f })
  ok('安装成功并报出装了 3 个口径层文件', r.ok && r.codeFiles === 3, JSON.stringify({ codeFiles: r.codeFiles }))
  ok('口径层落到 code/<版本>/', fs.existsSync(path.join(dataDir, 'code', '1.1.8.1', 'commands.js')))
  ok('三个入口都在（相对 import 也跟着摆对了位置）',
    [CODE_ROOT_FILE, ...Object.values(CODE_ENTRIES)].every((rel) => fs.existsSync(path.join(dataDir, 'code', '1.1.8.1', ...rel.split('/')))))
  ok('客户端自己生成了 {"type":"module"}（没有它 .js 会被当 CommonJS → import 直接语法错误）',
    JSON.parse(fs.readFileSync(path.join(dataDir, 'code', '1.1.8.1', 'package.json'), 'utf8')).type === 'module')
  ok('状态里记下口径层目录与入口 sha256',
    readWebState(dataDir).current?.codeDir === path.join('code', '1.1.8.1') &&
    /^[0-9a-f]{64}$/.test(readWebState(dataDir).current?.codeEntrySha256 || ''))

  const hot = resolveCodeDir({ dataDir, shellVersion: SHELL })
  ok('resolveCodeDir 给出热更目录（1.1.8.1 > 壳 1.1.8）', hot === path.join(dataDir, 'code', '1.1.8.1'), String(hot))
  const picked = await pickCodeModule({ hotDir: hot, builtins: FAKE_BUILTINS() })
  ok('★ 真实 import 成功：口径层来自热更', picked.source === 'hot' && !picked.error, picked.error)
  ok('★ 真的调到了热更那份实现（alpha() === "HOT"）', picked.modules.commands.alpha() === 'HOT')
  ok('search / analytics 也是同一份（否则就是口径分叉）',
    picked.modules.search.beta() === 'b' && picked.modules.analytics.gamma() === 'g')
}

console.log('\n=== ⑬ C 通道：用不用热更口径层的判断（版本 / 转正状态 / 内容完好）===')
{
  const { dataDir } = workspace()
  const code = makeCodeBundle()
  const { manifest, source } = makeBundle('1.1.8.1', { code })
  await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: makeFetch(source, manifest) })
  const at = (v) => resolveCodeDir({ dataDir, shellVersion: v })
  ok('壳涨到 ≥ 热更版本 → 弃用（装完新壳不该再跑旧口径层）', at('1.1.8').length > 0 && at('1.1.8.1') === null && at('1.1.9') === null)
  ok('壳比 minShellVersion 还老 → 不用', at('1.1.7') === null)
  // 模拟"上次启动记了尝试、但始终没等到健康确认"
  writeWebState(dataDir, { ...readWebState(dataDir), attemptedAt: new Date().toISOString(), confirmedAt: null })
  ok('上次没转正 → 这次先用内置（与页面层同一套回退规则）', at('1.1.8') === null)
  markHealthy(dataDir, 'gate')
  ok('转正之后又能用了', at('1.1.8') !== null)
  // 入口被人手改坏 → sha 对不上 → 不认
  fs.writeFileSync(path.join(dataDir, 'code', '1.1.8.1', 'commands.js'), 'export function alpha() { return "tampered" }\n')
  ok('入口内容对不上（磁盘坏/被改过）→ 拒绝加载', at('1.1.8') === null)
  ok('作废会落盘（不落盘就会每次启动都重试一遍、每次都失败）', abandonHotCode(dataDir, 'gate 测试作废').ok === true &&
    readWebState(dataDir).current.codeDir === null && /口径层已放弃/.test(readWebState(dataDir).lastCodeError || ''))
  ok('作废时记下时间（界面据此决定还要不要打扰用户）', !!readWebState(dataDir).lastCodeErrorAt)
  // 真机验证抓到的 bug：页面自检通过时 markHealthy 会清 lastError，把"口径层为什么没用"一起抹掉
  markHealthy(dataDir, 'gate')
  ok('★ 页面自检通过**不会**抹掉口径层的错误记录（用独立字段 lastCodeError）',
    /口径层已放弃/.test(readWebState(dataDir).lastCodeError || '') && readWebState(dataDir).lastError === null)
  ok('作废之后 resolveCodeDir 自然也不认', at('1.1.8') === null)
  ok('作废只影响口径层，页面层的版本信息还在', readWebState(dataDir).current.webVersion === '1.1.8.1')
}

console.log('\n=== ⑭ C 通道：绝不砖机（加载失败/出口不全都静默回内置）===')
{
  const { dataDir } = workspace()
  const code = makeCodeBundle({ breakSyntax: true })
  const { manifest, source } = makeBundle('1.1.8.1', { code })
  await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: makeFetch(source, manifest) })
  const hot = resolveCodeDir({ dataDir, shellVersion: SHELL })
  const picked = await pickCodeModule({ hotDir: hot, builtins: FAKE_BUILTINS() })
  ok('语法坏掉的口径层：不抛异常，静默回内置', picked.source === 'builtin' && picked.modules.commands.alpha() === 'builtin')
  ok('并且说清原因（能显示给 owner 看）', /加载失败/.test(picked.error || ''), picked.error)
}
{
  const { dataDir } = workspace()
  const code = makeCodeBundle({ alpha: 'HOT' })
  const { manifest, source } = makeBundle('1.1.8.1', { code })
  await installBundle({ manifest, baseUrl: manifest.baseUrl, dataDir, fetchImpl: makeFetch(source, manifest) })
  const hot = resolveCodeDir({ dataDir, shellVersion: SHELL })
  // 内置比热更多一个导出 = 热更包打歪了/漏了文件
  const picked = await pickCodeModule({
    hotDir: hot,
    builtins: { commands: { alpha() {}, extraOne() {} }, search: { beta() {} }, analytics: { gamma() {} } },
  })
  ok('出口集合不全 → 整包拒用（专拦"一半新一半旧"，它比彻底坏掉更难查）',
    picked.source === 'builtin' && /少了 1 个导出/.test(picked.error || '') && /extraOne/.test(picked.error || ''), picked.error)
}
{
  const picked = await pickCodeModule({
    hotDir: 'C:/definitely/not/here',
    builtins: FAKE_BUILTINS(),
    importFn: async () => { throw new Error('boom') },
  })
  ok('import 抛的错不会外泄（C1：宁可没热更，也不能把启动搞崩）', picked.source === 'builtin' && /boom/.test(picked.error))
  const none = await pickCodeModule({ hotDir: null, builtins: FAKE_BUILTINS() })
  ok('没有热更口径层时：直接用内置，不算错误', none.source === 'builtin' && none.error === null)
}

console.log('\n=== ⑮ 单入口 + 闭包：口径层只能有一个入口，且包必须完整 ===')
{
  const electronFiles = fs.readdirSync(path.join(REPO, 'electron')).filter((f) => f.endsWith('.js'))
  // commands.js 自己就是 barrel（属于命令层内部）；commandsLive.js 是**唯一**允许跨进来的入口
  const allowed = new Set(['commands.js', 'commandsLive.js'])
  const offenders = []
  for (const f of electronFiles) {
    if (allowed.has(f)) continue
    const src = read(path.join('electron', f))
    if (/from\s+'\.\/commands(\.js|\/[^']*)'/.test(src)) offenders.push(f)
  }
  ok('electron/ 下除 commandsLive.js 外没人直接 import 命令层（否则两份口径同时活着）',
    offenders.length === 0, offenders.join(' '))
  ok('commandsLive 三个入口都导出', /export const commands = /.test(read('electron/commandsLive.js')) &&
    /export const search = /.test(read('electron/commandsLive.js')) &&
    /export const analytics = /.test(read('electron/commandsLive.js')))
  ok('main.js 走唯一入口', /from '\.\/commandsLive\.js'/.test(read('electron/main.js')) && !/from '\.\/commands\.js'/.test(read('electron/main.js')))
  ok('server.js 走唯一入口', /from '\.\/commandsLive\.js'/.test(read('electron/server.js')) && !/from '\.\/commands\.js'/.test(read('electron/server.js')))
  ok('ai-orchestrator.js 走唯一入口', /from '\.\/commandsLive\.js'/.test(read('electron/ai-orchestrator.js')) && !/from '\.\/commands(\.js|\/)/.test(read('electron/ai-orchestrator.js')))
  ok('commandsLive 用 top-level await（口径层必须在 app.whenReady 之前定下来）',
    /const picked = await pickCodeModule\(/.test(read('electron/commandsLive.js')))
  ok('加载失败会把那一版作废（不反复重试）',
    /abandonHotCode\(runtime\.dataDir, picked\.error\)/.test(read('electron/commandsLive.js')))
  ok('webupdate:status 带上了口径层来源（界面能解释"为什么没用热更代码"）',
    /webUpdateStatus\(dataDir, resolvedWeb, codeOrigin\)/.test(read('electron/main.js')))
}
console.log('\n--- ⑮b 纯 Node 兼容：中心库服务器与后端断言都是在没有 Electron 的环境里 import 这份代码的 ---')
{
  // 这一次真的踩过：commandsLive 一开始写成静态 `import { app } from 'electron'`，
  // server.js 间接引用它 → 纯 Node 下解析就 SyntaxError → 后端 711 项断言一条都不出、中心库服务起不来。
  const src = read('electron/commandsLive.js')
  ok('没有静态 import electron（必须动态且容错地取）', !/^import\s+\{[^}]*\}\s+from\s+'electron'/m.test(src))
  ok('用动态 import 并容错（取不到就当不在 Electron 里）',
    /await import\('electron'\)/.test(src) && /catch \{ return null \}/.test(src))
  const live = await import('../electron/commandsLive.js')
  ok('★ 纯 Node 下 import 得动（否则中心库服务器直接起不来）', typeof live.commands === 'object' && live.commands !== null)
  ok('纯 Node 下自动回落内置口径层，且不算错误',
    live.codeOrigin.source === 'builtin' && live.codeOrigin.dir === null && live.codeOrigin.error === null,
    JSON.stringify(live.codeOrigin))
  ok('纯 Node 下三个命名空间都拿到了真东西',
    Object.keys(live.commands).length > 100 && typeof live.search.productNamesForSearch === 'function' &&
    typeof live.analytics.analyticsOverview === 'function',
    `commands 导出 ${Object.keys(live.commands).length} 个`)
  // server.js 是**中心库服务器**上那份（用纯 node 起），它绝不能因为口径层入口而变得不可 import。
  // 注意 ai-orchestrator.js 本来就依赖 electron（只在 Electron 里用），不在这一条的范围里。
  const srv = await import('../electron/server.js')
  ok('★ server.js 在纯 Node 下 import 得动（中心库服务器就是 `node` 起它的）',
    typeof srv.createInventoryServer === 'function')
}
{
  const cl = computeCodeClosure(path.join(REPO, 'electron'))
  ok('口径层闭包不含 import electron（含了就换不掉）', cl.electronImports.length === 0, cl.electronImports.join(' '))
  ok('口径层闭包没有跳出 electron/ 的相对 import', cl.escapes.length === 0, cl.escapes.join(' | '))
  ok(`口径层闭包规模合理（${cl.files.length} 文件），不是把整个 electron/ 都装进去`, cl.files.length > 20 && cl.files.length < 200)
  ok('闭包包含 barrel 与三个入口', [CODE_ROOT_FILE, ...Object.values(CODE_ENTRIES)].every((e) => cl.files.includes(e)))
  ok('闭包带上了目录外的依赖（license / channels / localSearch）—— 漏了就是"一半新一半旧"',
    ['license.js', 'channels.js', 'localSearch.js'].every((f) => cl.files.includes(f)))
  ok('外部依赖只有 Node 内置（因此不需要带 node_modules）',
    [...cl.externals.keys()].every((s) => s.startsWith('node:')), [...cl.externals.keys()].join(' '))
}
{
  const build = read('scripts/build-web-bundle.mjs')
  ok('发布侧用同一套闭包算法（不是各写一份）', /computeCodeClosure/.test(build))
  ok('发布侧会拦住"闭包里 import 了 electron"', /import 了 electron/.test(build))
  ok('发布侧支持 --no-code（单独撤掉一个坏口径层的办法）', /--no-code/.test(build))
  ok('CODE_ALLOWED_EXT 只收 .js', CODE_ALLOWED_EXT.size === 1 && CODE_ALLOWED_EXT.has('.js'))
}

// 清理临时目录
for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ } }

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
