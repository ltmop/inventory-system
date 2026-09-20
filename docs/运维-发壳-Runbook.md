# 运维 · 发壳（安装包）Runbook

> 「壳」= Windows 安装包（NSIS）。它换的是**主进程**那部分代码。
> 前端界面和口径层能走热更，**壳层不能** —— 这篇讲清楚什么必须发壳、怎么发、发完做什么。
> 最后更新：2026-09-21

---

## 1. 先回答"这次到底要不要发壳"（不要靠记性）

```bash
node scripts/shell-release-audit.mjs            # 与上一个装壳版本比（默认 tag v1.1.10）
node scripts/shell-release-audit.mjs --base v1.1.11
```

它用**和热更打包脚本同一份** `computeCodeClosure` 算边界，把改动分成五桶：

| 桶 | 能不能热更 | 说明 |
|---|---|---|
| ① B 通道（`src/` `public/` `index.html`） | ✅ 能 | 跑 `build-web-bundle.mjs` 就推得动 |
| ② C 通道闭包（`electron/commands*` 及相对 import） | ✅ 能 | 口径层，必须与 ① 一起发 |
| ③ 🔴 真·壳层（`electron/*.js`、`preload.cjs` 等） | ❌ **不能** | **只有安装包能换 → 有它就等于要发壳** |
| ④ 📱 手机端（`electron/mobile/**`） | ⚠️ 半能 | 有单独部署路：拷到中心库 `/opt/inventory-app/electron/mobile/` 即生效；但**桌面端局域网那份 `/m`** 要等装壳 |
| ⑤ 其他（docs/scripts） | — | 不影响发版 |

> ⚠️ 教训（2026-09-21）：我一开始以为 `electron/mobile/**` 也算"壳层"，差点把
> 「手机端要等装壳」写进结论 —— 实际上它有独立的部署路。分桶就是为了不再混。

---

## 2. 现在攒着什么（截至 2026-09-21，`v1.1.10` 之后）

### ③ 真·壳层 —— 必须发壳才生效

| 文件 | 改了什么 | commit | 不发的后果 |
|---|---|---|---|
| `electron/main.js` | ① `console.*` 加 `try/catch`（stdout 断了不再变成 `uncaughtException`）② 渲染进程崩溃自动重载**加节流**（60 秒最多 3 次，防无限闪屏） | `eb36284` | crash.log 继续被 EPIPE 假崩溃淹；万一前端一版加载即崩会不停闪屏 |

### ④ 手机端 —— 已单独部署到中心库，**桌面局域网那份**要等装壳

`electron/mobile/**`（商品图片、商品详情页、客户详情页、收款登记明细页等，见发布记录四补/五补）

### 建议顺手一起做（还没做，属于"下次发壳时值得带上"）

| 项 | 为什么 |
|---|---|
| `preload.cjs` 的中心库配置补齐条件 | 现在是 `if (cfg.url && cfg.token && !localStorage.getItem('fi-central-url'))` —— **只在 localStorage 没有时才注入**。改成"与 `central.json` 不一致就以 `central.json` 为准"，以后再换令牌就**不用人工重连**（这次轮换就得靠重启+重新登录，正是被这条守卫挡住的） |
| `updater.js` 的日志出口 | 已由 `main.js` 的 console 安全网覆盖，**可以不动**；若想让更新诊断更清楚，可给它一个写文件的 logger |

---

## 3. 发壳步骤

### 3.1 版本号要**同时改两处**（这是最容易漏的一步）

| 文件 | 从 | 到（举例） | 含义 |
|---|---|---|---|
| `package.json` 的 `version` | `1.1.10` | `1.1.11` | 壳版本 |
| `public/web-version.txt` | `1.1.10.3` | `1.1.11.0` | **内置前端版本**，规则是 `<壳版本>.<第几次前端改动>` |

**为什么两处都要改**：`electron/webUpdate.js:338` 的判据是
「热更包的 `webVersion` ≤ 内置版本 → 弃用热更包」。
把内置版本提到 `1.1.11.0`（> `1.1.10.3`），老热更包就自动作废，用户装完新壳看到的是**新壳自带的前端**，
不会出现"新壳 + 旧热更包"这种半新半旧的状态。

### 3.2 命令（`scripts/release.mjs` 是**唯一发布入口**）

```bash
npm run check:web                     # 官网版本号自检（固定夹具 + 线上实页，不用真发一版就能验）
node scripts/release.mjs --check      # 只做前置检查，不碰服务器
node scripts/release.mjs              # 全流程：[1/5]检查 → [2/5]打包 → [3/5]产物 → [4/5]部署更新源
                                      #          → [4b]官网下载页 → [5/5]三样验证 → [5b]官网验证
node scripts/release.mjs --skip-build --web-only   # 只补发官网（更新源已发好、官网漏了时用）
```

打壳单独跑可以用 `npm run dist`（`scripts/dist.cjs`：先 `npm run build` 再用 electron-builder 出 NSIS，
产物先落临时目录再拷回 `release/`，避开工作区文件监控导致的 EPERM）。
**但正常发版请走 `release.mjs`** —— 它内建了版本递增检查、部署前备份 `latest.yml`、三样验证，
以及"绝不碰服务器源码"的约束。

### 3.3 发完必须做的三件（`release.mjs` 只做到了前两件的自动验证）

- [ ] **更新源**：`/opt/inventory-cloud/updates/`（`latest.yml` + exe + blockmap），脚本已验证
- [ ] **官网**：`/var/www/junchengzn/download/` + 下载页版本号，脚本已验证
- [ ] **🔴 中心库的 `/app` 浏览器版 `dist`** —— **脚本不管这一步**，历来靠人工。
      现状：`https://app.junchengzn.com/app/web-version.txt` 还是 `1.1.10.0`。
      手机/浏览器打开 `/app` 看到的是这一份，不同步就跟桌面端界面不一致。
- [ ] **本机（收银机）装新壳**：装完才拿到 ③ 那些壳层修复
- [ ] **门店其他机器**：应用内更新或官网重装

### 3.4 发完顺手清一下

`/opt/inventory-cloud/updates/web/` 会累积热更版本目录（旧版是回滚资产，但不必全留）。
建议只保留最近 1–2 个 + 每个 `latest.json.bak-*` 里最新的那个。

---

## 4. 版本号与"谁能覆盖谁"

```
壳 1.1.11（安装包）——  装了才变，变不了就一直是它
  └─ 内置前端 1.1.11.0 —— 随壳走
       └─ 热更前端 1.1.11.x —— 只要 > 内置 且 minShellVersion ≤ 壳，就生效
```

三条客户端判据（都在 `electron/webUpdate.js`）：

1. `cmpVersion(webVersion, currentWebVersion) > 0` —— 不新就不收（:180）
2. `cmpVersion(shellVersion, minShellVersion) >= 0` —— 壳太老不收（:183-185）
3. 内置版本 ≥ 热更包版本 → **弃用热更包**（:338，reason=`内置版本已更新，弃用热更包`）

---

## 5. 回滚

| 退什么 | 怎么做 |
|---|---|
| 退**热更前端** | 服务器把 `updates/web/latest.json` 换成上一个 `.bak-*`；或直接删掉 `latest.json`（客户端不动，退到壳内置版本） |
| 退**壳** | 官网/更新源换回上一版 exe，让用户重装（Windows 上装低版本通常要先卸载） |
| 退**更新源指针** | `sudo cp /opt/inventory-cloud/updates/latest.yml.bak-<ts> /opt/inventory-cloud/updates/latest.yml` |

---

## 6. 常见坑（踩过的）

1. **只改了 `package.json` 没改 `public/web-version.txt`** → 老热更包不会被弃用，出现"新壳配旧前端"。
2. **`updates/` 与官网只发了一边** → `release.mjs` 里的版本递增检查会把"服务器已等于本地"当成错误挡住全流程；
   这时用 `--skip-build --web-only` 补官网。
3. **把别人给的 `latest.json` 直接传上去** → 清单必须是自己构建出来的（脚本会自检，但别绕过脚本）。
4. **以为改 `electron/mobile/**` 必须发壳** → 不必，手机端有单独部署路；但**桌面局域网那份要发壳**。
5. **远端 `updates/flags.json` 是无鉴权静态文件** → 能改它的人能关/开功能（"开"只有建议权，本机可否决）。
