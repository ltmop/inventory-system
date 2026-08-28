// 一键打包：先构建前端，再用 electron-builder 打出 NSIS 安装包
// 注意：输出目录必须避开工作区（工作区文件监控会锁定解压目录导致 EPERM），
//       因此先输出到临时目录，再把安装包拷回 release/
const { build, Platform } = require('electron-builder')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/'
// electron-builder 内部会 spawn npm.CMD（经 PowerShell），精简 PATH 环境下需补回系统目录
const windir = process.env.SystemRoot || 'C:\\Windows'
process.env.PATH = `${windir}\\System32;${windir}\\System32\\WindowsPowerShell\\v1.0;${process.env.PATH}`

const tmpOut = path.join(os.tmpdir(), 'fi-release')

/** 递归收集目录下所有 .js/.cjs 文件 */
function collectJs(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) out.push(...collectJs(p))
    else if (/\.(js|cjs)$/.test(name)) out.push(p)
  }
  return out
}

/** 打包前哨兵：
 *  1) 所有 electron/ 下 .js/.cjs 过 node --check（tsc/vitest 都覆盖不到 electron/）
 *  2) 运行时引用检查：ESM 文件里出现裸 require() 会在运行时抛 ReferenceError（node --check 检不出）
 *  3) __dirname / __filename 未定义就被使用同样会运行时崩（ESM 没有它们）
 */
function syntaxCheckMainProcess() {
  const files = collectJs(path.resolve('electron'))
  if (files.length === 0) throw new Error('electron/ 目录为空，打包前哨兵没扫到文件')
  for (const f of files) {
    try {
      execSync(`node --check "${f}"`, { stdio: 'pipe' })
    } catch (e) {
      throw new Error(`主进程语法检查失败: ${f}\n${e.stderr?.toString() ?? e.message}`)
    }
    // ESM 裸 require 检测（.cjs 允许 require，跳过）
    if (f.endsWith('.js')) {
      const src = fs.readFileSync(f, 'utf8')
      const requireHits = src.match(/\brequire\s*\(\s*['"]/g) || []
      const hasCreateRequire = /createRequire|module\.createRequire/.test(src)
      if (requireHits.length > 0 && !hasCreateRequire) {
        throw new Error(`ESM 文件出现裸 require()，运行时必崩: ${f}（${requireHits.length} 处）`)
      }
      // __dirname/__filename 使用但未定义检测
      if (/\b__dirname\b|\b__filename\b/.test(src) && !/fileURLToPath/.test(src)) {
        throw new Error(`ESM 文件使用了 __dirname/__filename 但未定义（缺 fileURLToPath 导入）: ${f}`)
      }
    }
  }
  console.log(`✓ 主进程 ${files.length} 个文件语法+运行时引用检查通过`)
}

;(async () => {
  syntaxCheckMainProcess()
  execSync('npm.cmd run build', { stdio: 'inherit' })

  await build({
    targets: Platform.WINDOWS.createTarget(),
    config: { directories: { output: tmpOut } },
  })

  // 按 package.json 的 version 精确挑安装包：临时目录是复用的，
  // 直接 find('Setup') 可能命中上次构建留下的旧版本安装包
  const { version } = require('../package.json')
  const releaseDir = path.resolve('release')
  fs.mkdirSync(releaseDir, { recursive: true })
  // 临时目录是复用的，同版本号可能残留旧包：按修改时间取最新
  const candidates = fs
    .readdirSync(tmpOut)
    .filter((f) => f.endsWith('.exe') && f.includes(`Setup ${version}`))
    .map((f) => ({ f, m: fs.statSync(path.join(tmpOut, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  const installer = candidates[0]?.f
  if (!installer) throw new Error(`未找到安装包产物（期望文件名含 "Setup ${version}"）`)
  fs.copyFileSync(path.join(tmpOut, installer), path.join(releaseDir, installer))
  console.log(`\n安装包已就绪: release/${installer}`)
})().catch((e) => {
  console.error('打包失败:', e.message)
  process.exit(1)
})
