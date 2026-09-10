# 进销存系统 · 编程Agent 交接文档（下一位接手必读）

> 2026-09-09 · 交接人：上一任编程Agent · 目标读者：下一位接手进销存线的编程 Agent
> 一句话：进销存桌面 v1.0.9 已发布（自动更新源 + 官网下载 + GitHub 同步），数据同步（多设备云 + 中心库单一来源 + 幂等键）完善；P0 归一的 live 翻转（现网桌面→中心库）待 owner 门店执行。

---

## 一、当前进度（2026-09-09，已核实）

### 已交付（可验证）

| 项 | 状态 | 证据 |
|---|---|---|
| 桌面 v1.0.9 发布 | 完成 | release.mjs 自动链：自动更新源 sync.junchengzn.com/updates/latest.yml = 1.0.9；官网下载 junchengzn.com/download/general-inventory-setup-1.0.9.exe = 200；docs/index.html = 1.0.9 |
| GitHub 开源同步 | 完成 | ltmop/inventory-system main = 93ae5d5（含 v1.0.9 + docs/CHANGELOG.md），本地/远端 0/0 |
| 多设备云同步 | 完成 | cloud.js → sync.junchengzn.com（AES-256 整库快照） |
| 中心库单一来源 | 已部署验证 | app.junchengzn.com /api/invoke 带 token 返回真实数据；与桌面 electron/server.js 同命令层 |
| 写接口幂等键 | 完成 | /api/invoke 写channel + /api/outbound 携带 idempotencyKey → 重复提交返回原结果不重复记账；611 断言全绿 |
| 清仓建议引擎 MVP-1 | 完成 | inv-analytics.mjs clearance（P0/P1/P2 + 建议区间 + 护栏）+ ReportsPage 卡 + 导出CSV；8 fixture 断言 |

### 未完成 / 待 owner（关键）

- P0 归一 live 翻转：桌面默认仍是本地 IPC（window.fi），中心库是设置里 opt-in。目标=默认切中心库 + 账号/备份收敛一轨。代码基础设施已就绪（src/lib/api.ts rawBackend 中心库优先；CloudLoginGate 登录即 setCentralConfig；CloudCard 识别 centralOn），Runbook 已写，但 live 翻转需门店桌面环节 + owner 授权（动现网在用的账）。
- 中心库数据缺口：中心库 /opt/inventory-app/data/data.db 现有 批次306 / 流水303，但 txout=0（零销售）、customers=0 → 只有库存/入库镜像，没有门店真实销售/客户/应收（真实账在门店桌面本地库）。这是『单店一分不差』迁移的核心难点。
- 手机端/其他线仍有未提交改动（多 Agent 脏树），未处理。

---

## 二、系统框架（架构与链路）

### 两条产品线 + 云

1. 桌面版（本仓库）：AI智能管理进销存系统，Electron + React + SQLite/WAL，本机数据。
2. 手机版：D:\mobile-app-ading，Capacitor + 纯 HTML 零构建，sql.js WASM。
3. 云：cloud-server（云同步/账户/多设备/加密）+ 中心库（整机共享单一来源）。

### 核心链路（口径一致的关键）

```
桌面界面(src/) → IPC(electron/main.js + preload.cjs) → 命令层(electron/commands/) → SQLite/WAL
手机端(/m/) → electron/server.js → 同一命令层(commands/)   ← 两端口径复用同一命令层
云同步: electron/cloud.js → sync.junchengzn.com (AES-256-GCM 整库快照)
中心库: src/lib/api.ts createHttpBackend → app.junchengzn.com /api/invoke → 同 electron/server.js + 命令层 + db.js
```

### 数据源三形态（src/lib/api.ts 的 rawBackend，优先级从高到低）

1. 中心库：设了 fi-central-url + fi-central-token（localStorage）→ createHttpBackend 连 app.junchengzn.com /api/invoke（多点实时共享）。
2. 本地 IPC（当前默认）：Electron preload 暴露 window.fi → 主进程命令层 → 本地 SQLite。
3. 局域网 http：其他电脑/平板浏览器打开主机 /app?token=... → /api/invoke。
4. 纯浏览器 dev（npm run dev 无 token）：backend=null，store 回退 mock。

### 服务器（同一台 43.128.20.39，多域名）

| 域名 | 作用 | 服务器目录 | pm2 |
|---|---|---|---|
| app.junchengzn.com | 中心库（整机共享单一来源 /api/invoke） | /opt/inventory-app（start-central.mjs，port 3200，DB data/data.db） | inventory-app |
| sync.junchengzn.com | 云同步/更新源（cloud-server，Caddy→3100） | /opt/inventory-cloud（index.js+store.js，updates/=进销存更新源，cockpit-updates/=驾驶舱） | inventory-cloud |
| junchengzn.com | 官网/下载页 | /var/www/junchengzn（index.html/docs/download） | - |
| 驾驶舱 | cockpit 云端 | /opt/inventory-cloud/cockpit-updates + D:\B5-COE驾驶舱\desktop-app | cockpit-remote |

### 关键文件地图

- 命令层：electron/commands/（outbound/inbound/reports/clearance/...）+ commands.js（re-export）。
- IPC：electron/main.js（ipcMain.handle）+ electron/preload.cjs（CHANNELS 白名单）。
- 数据库：electron/db.js（SCHEMA_SQL + MIGRATIONS）；老库迁移只增不改。
- 手机服务：electron/server.js（/api/invoke 的 INVOKE_CHANNELS 分发 + /api/outbound + /m + /app + /updates/*）。
- 分析 CLI：scripts/inv-analytics.mjs（overview/sales/stock/dormant/clearance/first-sale/customers/top/raw）。
- 云 CLI：scripts/inv.mjs（config/register/login/status/sync/backup/restore/devices）。
- 前端：src/pages/（ReportsPage 等）+ src/store/appStore.ts + src/lib/api.ts。
- 发布链：scripts/release.mjs（检查→打包 dist.cjs→ASCII产物→部署→三样验证）。
- 测试：scripts/test-backend.mjs（611 断言，改动后必跑）。

---

## 三、开发经验（先读复盘，再动手）

### 必读复盘文档

- 进销存系统开放经验与教训.md（A1知识库70- / 项目 docs/，7章；动手前先读第三章「失败与错误记录」）。
- 进销存系统全链路开发经验-2026-09.md、进销存系统实战经验与教训-20260906.md。
- 本次新增：docs/CHANGELOG.md（v1.0.9）。

### 工作流（照做）

1. 前置检查：项目路径存在、node_modules 齐、git status 看清（防并发覆盖）、DB 在 %APPDATA%\fishing-inventory\（不在项目里找 .db）。
2. 改代码：命令层加模块 → commands.js re-export → IPC main.js + preload CHANNELS（两端通道名一致）→ 类型 src/types/index.ts → 前端页 → 验证。
3. 验证三件套：npm run build（tsc+vite）+ node scripts/test-backend.mjs（611）+ npx vitest run。606/611 只加不减。
4. 老库迁移：MIGRATIONS 加 PRAGMA table_info 判空 → ALTER TABLE ADD COLUMN；重表建新→INSERT SELECT→DROP→RENAME；失败从 .pre-migration.bak 恢复。
5. 打包发布：node scripts/release.mjs（一键：检查→打包→ASCII产物→部署→三样验证；版本必须递增；只部署产物不碰服务器源码）。

### 本次沉淀的关键经验

- 幂等键设计：客户端每次逻辑操作生成唯一 key、重试复用、换单重置（手机 pos.js 的 idemFor()）；服务端 idemCache（channel:key，TTL 15min）判重返回原结果。切勿每次调用生成新 UUID（判不了重）。
- 单一来源：命令层/CLI/IPC 共用同一函数（如 buildClearance(db)），避免渲染层重算导致口径分叉；ReportsPage 经 IPC clearance:get 拉真实数据。
- 只读引擎：清仓引擎零写入（DB 跑前跑后大小一致）、给区间不给自动价（自动决策伤账号/信任）。

---

## 四、官方网址 + 服务器密钥位置

### 网址

| 用途 | 地址 |
|---|---|
| GitHub 开源仓库（公开） | github.com/ltmop/inventory-system（gh 已登录 ltmop，repo scope） |
| 官网/下载页 | https://junchengzn.com（下载 junchengzn.com/download/general-inventory-setup-<版本>.exe） |
| 云同步 / 自动更新源 | https://sync.junchengzn.com（/updates/latest.yml、/updates/inventory-system-setup-<版本>.exe） |
| 中心库（整机共享） | https://app.junchengzn.com/api/invoke |
| 驾驶舱云端 | https://sync.junchengzn.com/cockpit-updates/ |

### 服务器与密钥

| 项 | 值 |
|---|---|
| 服务器 IP | 43.128.20.39 |
| 登录用户 | ubuntu |
| SSH 私钥 | C:\Users\Administrator\.ssh\skey-junchengzn.pem（ssh config: Host juncheng） |
| 连接方式 | ssh -i "C:\Users\Administrator\.ssh\skey-junchengzn.pem" -o StrictHostKeyChecking=no ubuntu@43.128.20.39（工具 ssh_exec/ssh_list 有序列化 bug，用原生 ssh） |
| 中心库 token | 服务器 /opt/inventory-app/data/server-token.txt（写）/ server-view-token.txt（只读） |
| ADMIN_KEY（cloud-server） | 服务器 pm2 inventory-cloud 的 env/env-file（本机没有，不回显） |
| Node22（服务器 SQLite） | /opt/node22/bin/node --experimental-sqlite（系统 node 是 v18，无 sqlite） |

### 本机路径

| 项 | 路径 |
|---|---|
| 桌面项目（本仓库） | C:\Users\Administrator\Desktop\库存管理\AI智能管理进销存系统 |
| 桌面运行库 | %APPDATA%\fishing-inventory\data.db |
| 手机版 | D:\mobile-app-ading |
| 通用进销存（cloud-server + 驾驶舱 desktop-app） | D:\通用进销存 |
| 驾驶舱 | D:\B5-COE驾驶舱 |
| 知识库 | D:\A1-AI知识库（进销存文档在 70-进销存系统项目） |

---

## 五、注意事项 / 红线 / 坑（重要）

### 红线（动=事故）

- 不动 进销存共用云端点：/api/pair、/api/snapshot、/api/snapshot/fetch、/api/backup*（进销存 electron/cloud.js 与 cockpit 共用）。
- 不碰 服务器源码：release.mjs 只部署发布产物，绝不覆盖 /opt/inventory-cloud/index.js+store.js（避免旧版覆盖新版）。
- 不覆盖/清空 现网账：迁移动现网账前必先备份 + 灰度一台 + 核对账实；本地库作回滚底不清空。
- 删除/人事/转账类操作一律请示 owner（阿杜）。

### 并发编辑纪律（本仓库是多 Agent 脏树）

- 报「干净」前必 git status --porcelain；改动前先 git diff 看清；提交只 add 本任务文件（勿 git add -A 扫入他人改动）。
- 定唯一写入方；发布前确认版本递增 + git status。

### 环境坑（本次踩过，直接用解法）

| 坑 | 解法 |
|---|---|
| glob/grep 报 ripgrep launch failed | 用 pwsh Get-ChildItem / Select-String 替代 |
| 大文件 read 后 write 回写 → 截断损坏 | 大文件只用 edit 精确替换或用 PowerShell |
| PowerShell 无 tail/head，curl 是 Invoke-WebRequest 别名 | 用 Select-Object -First/Last、curl.exe、Invoke-WebRequest |
| 远程 bash 命令含括号/中文 → syntax error | 远程命令用纯 ASCII、无括号；中文文件名用 base64 传 |
| 服务器系统 node 是 v18（无 sqlite） | 用 /opt/node22/bin/node --experimental-sqlite |
| 静态/更新路由只认 GET（HEAD→404） | 验证下载/更新包用 GET（curl -sL -o /dev/null -w %{http_code}） |
| electron-builder 打包中文路径 7za 失败（Cannot open N files） | 拷到 ASCII 路径（如 C:\cockpit-asc）再构建 |
| ssh_exec/ssh_list/get_goal 报 binding arguments must be lossless JSON | 用原生 ssh -i；goal 工具直接带已知 id/revision 调 update_goal |
| 短信验证码 mock（COCKPIT_SMS_MOCK=1，测试码 123456） | 生产 pm2 绝不能设；未接真网关前自助注册/找回不上生产 |

### 发布注意

- 版本必须递增（release.mjs 会拒绝 ≤服务器版本）；本地版本在 package.json 的 version。
- 发布链自检：publish.url 必须 https；ASCII 产物名（inventory-system-setup-x.y.z.exe，避开中文 URL 编码）；部署前自动备份服务器 latest.yml。
- 发布后三样验证：latest.yml 版本 / sha512 / 下载 GET 200。

---

## 六、下一步建议（接手即可做）

1. 先跑基线：node scripts/test-backend.mjs（应 611 全绿）+ npm run build。
2. 读复盘第三章 + 本交接文档。
3. P0 归一 live 迁移（若 owner 已就绪门店桌面）：按 D:\A1-AI知识库\70-进销存系统项目\进销存P0归一-中心库默认-收敛迁移Runbook.md 执行「备份→灰度一台→核对账实→全量」。
4. 清仓建议后续（留档未做）：定价建议引擎 MVP-2 / 到期日数据补齐（解锁 P0 紧急清）/ 清仓建议桥驾驶舱任务三件套。
