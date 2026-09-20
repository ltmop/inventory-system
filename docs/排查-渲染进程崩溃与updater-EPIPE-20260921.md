# 排查 · 渲染进程崩溃 与 electron-updater 的 EPIPE

> 起因：owner 选项 5「查 crash.log 的渲染进程崩溃」。
> 结论先行：**9 条记录里 4 条是"假崩溃"，5 条是真崩溃但发生在 9/15–9/16 开发热更功能期间
> （非打包的日常运行），此后 4 天零新增。** 已加两道防护，都不改变业务逻辑。
> 排查日期：2026-09-21

---

## 1. 结论（TL;DR）

| 结论 | 依据 |
|---|---|
| **4 条 EPIPE 是假崩溃**，不是业务故障 | 栈顶是 `electron-updater` 内部的 `console.info` 往一个已关闭的 stdout 管道写 |
| **5 条 render-process-gone 是真崩溃，但来自"源码运行"的那几天** | 埋点行号 `main.js:716/720/724/737` 对应 9/15 前后那几版 main.js（0915 版正好在 720 行） |
| **日常在用的打包版今天 0 条新增** | 最近一条是 9/16 05:28（4 天前）；当前跑的是 `…\Programs\inventory-system\AI智能管理进销存系统.exe` |
| **崩溃与 9/15–9/16 的功能开发强相关** | `main.js` 那两天被大改（P1 热更 `d54312d`、P3 功能开关 `9e409ef`），改完就不再有新条目 |

**一句话**：这不是"线上一直在崩"，而是"开发那两天崩过几次，且日志被假崩溃淹了一半"。
真正的危害是**后者** —— 淹掉的日志让下次真出事时查不出来（我这次就差点被误导）。

---

## 2. 证据链

### 2.1 crash.log 的构成（9 条）

| 类型 | 条数 | 关键栈帧 |
|---|---|---|
| `uncaughtException: Error: EPIPE: broken pipe, write` | 4 | `console.info` ← `NsisUpdater.isUpdaterActive`

← `NsisUpdater.checkForUpdates` ← `electron/updater.js:76` |
| `render-process-gone: reason=crashed exitCode=-1` | 5 | `electron/main.js:716 / 720 / 724 / 737` |

### 2.2 为什么说 EPIPE 是"假崩溃"

`updater.js:74-78` 在启动 10 秒后调 `autoUpdater.checkForUpdates()`。electron-updater 默认把日志
交给 `console`，而主进程 `console` 写的是 **stdout**：

- 从终端启动、之后**终端被关掉** → 管道的读端没了 → 再写就 `EPIPE`
- 或者被别的东西**当子进程**启动（stdio 已关闭）

栈里的路径是 `C:\Users\Administrator\Desktop\库存管理\…\node_modules\electron-updater\…`
—— **不是打包后的 asar 路径**，说明这几条来自"直接跑源码"的方式，不是店里那个安装版。

`EPIPE` 不是业务错误，它只是"日志写不出去"，却被 `process.on('uncaughtException')`
（main.js:79）当成崩溃记了一条。**这就是"假崩溃"的定义。**

### 2.3 为什么说是"开发那两天"的崩溃

`logCrash('render-process-gone', …)` 的调用行号在日志里是 716/720/724/737 四个不同的值
—— 同一份代码只有一个位置，四个行号只能说明**main.js 当时在反复改**：

```
git show d54312d:electron/main.js | grep -n logCrash
  720: logCrash('render-process-gone', …)   ← 与日志里的 720 完全吻合
```

而 `git log` 显示 main.js 正是在那两天被大改：
- `d54312d` 2026-09-15 P1 前端局部热更（B 通道）+ 四道护栏
- `9e409ef` 2026-09-16 P3 功能开关

9/16 之后 crash.log 再无新增条目。

> ⚠️ 注意：crash.log 在 `%APPDATA%\fishing-inventory\`（`dataDir`，main.js:54），
> **源码运行与打包运行共用同一个文件** —— 所以两边的崩溃会混在一起，这也是排查绕弯的原因。

---

## 3. 已做的两道防护（commit `eb36284`）

⚠️ **都是壳层改动**（`electron/main.js`），不在热更闭包
（`scripts/lib/code-closure.mjs` 只含 `electron/commands*`）——
所以**要等下次装安装包才生效**，现在改的只是"下次别再这样"。

| # | 改什么 | 为什么 |
|---|---|---|
| ① | 给 `console.log/info/warn/error/debug` 包一层 `try/catch` | 日志写不出去绝不该变成 `uncaughtException`。做完之后 crash.log 恢复成"只记真崩溃" |
| ② | `render-process-gone` 自动重载**加节流**：60 秒最多 3 次 | 原来是无条件 `reload()`。要是加载的那版前端一进来就崩（显卡驱动抽风/资源损坏），会**不停闪屏**，比停下来更糟。超限时写一条 `render-process-gone-storm` 再停手 |

断言已钉住这两条（`scripts/test-backend.mjs` 36e 节），防止以后被无意改回去。

---

## 4. 没做的（以及为什么不盲做）

- **`reason=crashed` 的根因没有确证**。Electron 里渲染进程"crashed"最常见是
  GPU/显存问题，其次是内存不足。但 9/16 之后不再复现，"无法复现的崩溃"按定义就没法定根因。
- **没有加 `app.disableHardwareAcceleration()`**。它确实能绕开一大批 GPU 类崩溃，代价是
  整机界面渲染变慢——在**当前不再复现**的前提下，这是"为了修一个不存在的问题而降低日常体验"。
  建议：**先不动**；若哪天又开始崩，把它当第一顺位试验（改一行、观察一周）。
- **没有动 `updater.js` 的 `checkForUpdates` 时机**。10 秒静默检查本身没问题，
  问题只是它的日志出口，已由防护①覆盖。

## 5. 下次怎么自查（给自己留的检查清单）

1. `%APPDATA%\fishing-inventory\crash.log` 看**日期分布**：只要集中在某几天，多半是那天在开发。
2. 看到 `uncaughtException … EPIPE`：**直接判定为假崩溃**，忽略。
3. 看到 `render-process-gone-storm`：说明前端某版一加载就崩且已重载 3 次——
   这时该怀疑**刚热更的那版前端**，而不是显卡。回滚热更包即可（见发布记录里的回滚命令）。
4. 看到成片的 `render-process-gone`（无 storm）跨越多天：才值得去查 GPU/内存。
