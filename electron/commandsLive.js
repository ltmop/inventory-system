// 命令层（口径层）的**唯一入口**（P2，2026-09-15）
//
// 为什么必须有这个文件：
//   命令层原本被 3 个地方静态 import（main.js / server.js / ai-orchestrator.js）。
//   如果只把其中一个改成"从热更目录加载"，就会出现**两份口径同时活着** ——
//   同一件事在收银页面和在服务端算出不同结果，正是这个项目一直在治的病。
//   所以口径层只能有一个入口：本文件。闸门 check:webupdate 断言"electron/ 下只有这里 import 命令层"。
//
// C 通道（口径层热更）就在这里生效：
//   · 用 top-level await 在**模块加载时**决定用哪一份。必须在 `app.whenReady()` 之前完成
//     —— 因为 main.js 拿到命令层就直接开始注册 IPC 了；
//   · 热更那份 import 失败、或出口集合不全 → **静默回内置**并把它作废（护栏 C1：绝不砖机）。

import path from 'node:path'
import * as builtinCommands from './commands.js'
import * as builtinSearch from './commands/search.js'
import * as builtinAnalytics from './commands/analytics.js'
import { resolveCodeDir, abandonHotCode, pickCodeModule } from './webUpdate.js'

/** 日志必须包起来：GUI 进程的 stdout 可能是个坏管道，写日志本身不该把启动搞崩（踩过 EPIPE） */
const note = (level, msg) => { try { console[level](msg) } catch { /* 写不出去就算了 */ } }

// ⚠️ electron 必须**动态且容错**地取：
//   本文件被 server.js 间接引用，而 server.js 还要在**纯 Node** 下跑 ——
//    ① 中心库服务器上部署的就是 electron/ 这份代码（用 node 起，没有 Electron 运行时）
//    ② 后端断言/闸门也在纯 Node 里 import server.js
//    静态 `import { app } from 'electron'` 在纯 Node 下会直接 SyntaxError → 整个服务起不来。
//    取不到 app 就当作"不在 Electron 里" → 一律用内置口径层，行为与以前完全一致。
const electronApp = await (async () => {
  try {
    const mod = await import('electron')
    return (mod && mod.app) || null
  } catch { return null }
})()

let runtime = null
if (electronApp) {
  try {
    runtime = {
      dataDir: path.join(electronApp.getPath('appData'), 'fishing-inventory'),
      shellVersion: String(electronApp.getVersion()),
    }
  } catch { runtime = null }
}

let hotDir = null
if (runtime) {
  try {
    hotDir = resolveCodeDir(runtime)
  } catch { hotDir = null }
}

const picked = await pickCodeModule({
  hotDir,
  builtins: { commands: builtinCommands, search: builtinSearch, analytics: builtinAnalytics },
})

if (picked.error) {
  // 记进状态文件 + 作废这一版：不落盘的话每次启动都会再试一次、每次都失败。
  // 记进 lastError 还有个好处 —— 界面（WebUpdateBanner）能把原因显示出来，不用去翻日志。
  if (runtime) { try { abandonHotCode(runtime.dataDir, picked.error) } catch { /* 记不上也只是多试一次 */ } }
  note('warn', '[commands] 热更口径层未启用：' + picked.error)
} else if (picked.source === 'hot') {
  note('log', '[commands] 口径层来自热更：' + hotDir)
}

/** 命令层汇总出口（原来叫 './commands.js'，现在统一从这里拿） */
export const commands = picked.modules.commands
/** 被 server/orchestrator 直接引用的两个模块：也必须来自同一份，否则就是口径分叉 */
export const search = picked.modules.search
export const analytics = picked.modules.analytics
/** 这次启动口径层的来源（给 webupdate:status 与界面用） */
export const codeOrigin = { source: picked.source, dir: picked.source === 'hot' ? hotDir : null, error: picked.error }
