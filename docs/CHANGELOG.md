# 进销存系统 CHANGELOG

## v1.0.12 已发布 (2026-09-13) — 发布链路 + 中心库服务端补齐渠道

### 发布（已完成）
- **1.0.12 已发布到自动更新源**：`https://sync.junchengzn.com/updates/`，
  公网 `latest.yml` = 1.0.12 已校验（version 与 sha512 均与本地一致），安装包 200。
  上线名 `inventory-system-setup-1.0.12.exe`（ASCII 约定），旧清单已备份可回滚。
- 新增 `scripts/publish-update.mjs`：发布只有一条命令。它负责
  把中文名包改成服务端约定的 ASCII 名、按文件真实值重写 `latest.yml`
  （sha512/size 现算，不抄）、上传三个产物、并**公网回读校验** version 与 sha512。
  以前这一步要靠人记约定 + 手工改 yml，且 `release/latest.yml` 会一直停在旧版本。
- 更正 CHANGELOG 历史：线上更新源在 2026-09-11 就已发到 1.0.10，不是 v1.0.9 段写的 1.0.9。

### 中心库服务端补齐渠道（重要，先于客户端发布）
- 实测：中心库服务端 `/opt/inventory-app/electron/commands/outbound.js` 里 `channel` 命中 **0**，
  也没有 `channels.js`。也就是说**先发客户端、再有人用中心库模式开单**，
  渠道会被服务端 INSERT 丢掉、再被 DB 触发器兜成「线下」→ **Shopee 单静默变线下，且看起来正常**。
- 已部署 `electron/channels.js`（新增）+ `electron/db.js` + `electron/commands/outbound.js`，
  备份在 `/opt/inventory-app/electron.bak-channel-20260913-103439/`。
  部署前逐行 diff：24 行"服务端独有"内容全部可归因于旧实现，**未丢失任何服务端热修**。
- 部署后：pm2 `inventory-app` online、`central db opened, products: 324`、
  中央库 `integrity_check: ok` 且数据未变。
- 结论写进 `docs/发布记录.md` 的「部署顺序」一节：**先服务端，后客户端。**

### 仍未做
- **两台机器尚未实际升级到 1.0.12**（需现场）。不升级则同步/离线/渠道都不生效。

## v1.0.12 (2026-09-13) — 重打安装包 / 销售渠道 / 发布可追溯

### 发布
- **1.0.12 安装包产出**，取代作废的 1.0.11。1.0.11 是 09-12 手工 bump 的、**没落进任何提交**
  （`package.json` 停 1.0.10、`package-lock` 停 1.0.11，互相矛盾），之后又落了 12 提交 / 46 文件 / +3190 行，
  离线、渠道、幂等修复、B1 运维都不在里面 → 已移到 `release/旧版本/` 防误发。
- 本次把版本落进 git（`2d23986`）再打包，并新建 `docs/发布记录.md` 记「安装包 ↔ 提交 ↔ sha256」，
  补上以前查不出包对应哪份代码的缺口。
- `scripts/dist.cjs`：过去只拷 `.exe`，`release/latest.yml` 一直停在旧版本（实测停在 8/14 的 1.0.9），
  发布要自己去 `%TEMP%` 翻。现在一并产物化 `.blockmap` + `latest.yml`，并**当场校验**
  `latest.yml` 的 `version` 与 `package.json` 一致、指向本次构建的 exe，不一致直接中止（防自动更新到错版本）。
- 逐字节探针确认同步引擎 / 离线层 / 渠道字段**确实在 1.0.12 的 `app.asar` 内**，不只是源码里有。

### 销售渠道 channel（首单北极星判据的前置）
- 「开出首单」的判据是 `type=out 且 selling_price>0 且 渠道=Shopee`，但**全库原本没有渠道字段**
  （中央库 27 表、桌面库 28 表逐表核实；此前 grep 到的 10 处 `channel` 是同名不同义）。
- 新增 `electron/channels.js`（取值 线下/Shopee/优选仓/其他，单一事实源）+ `transactions.channel` 列
  + DB 层默认触发器（出库空渠道 → 线下）+ 单品出库与**多品开单两条命令路径**的落库
  + 开单界面渠道选择器。**Shopee 只能显式选**，禁止按金额/客户/时间推断。
- 生产两库均已补列回填并各自 `VACUUM INTO` 备份自证。中央库实测：优选仓 31 / 线下 1 / 入库 NULL 333，
  `渠道=Shopee` **0 行**。⚠️ 中央库存 1 笔 `type=out 且 金额>0`（¥7.50 现金）——
  **去掉渠道条件北极星今天就会被误判成「已出」**，判据里的渠道条件是承重的。

### 修掉一个会让「加字段」白加的静默缺陷
- `scripts/migrate-sync-changelog.mjs` 只用「触发器在不在」判断，且建表用 `CREATE TRIGGER IF NOT EXISTS`
  → 表加了新列后 `trg_*_upd` 的 WHEN 子句**永远不会更新**，该列的改动不进 `sync_changelog`，
  多端同步静默漏掉（实测它仍报「0 个需要改」，而触发器里确实没有 channel）。
- 改为按当前列现算期望 SQL 与 `sqlite_master` 原文归一化比对，报 最新/过旧→重建/缺失→新建，
  执行时先 DROP 再 CREATE。修后实测 56 最新 / 恰好 1 过旧（正是加了列的 transactions）。
- 两个迁移脚本的预迁移备份从 `fs.copyFileSync`（拷活 WAL 库会漏最近事务）改为 `VACUUM INTO` + 自证不一致即 exit 1。

### 运维
- 新增 `docs/运维-中心库归一-翻转Runbook.md`：核实了「默认走本地 IPC、中心库是设置里 opt-in」，
  并给出安全翻转顺序。
- **更正本节下方 v1.0.9 的说法**：「登录即 `setCentralConfig`（默认切中心库入口）」**不准确**。
  实测 `CloudLoginGate.tsx` 里登录与「连接中心库」是两个独立的手动动作，**登录不会**把机器切到中心库。
  原描述会让人以为登录是安全的，从而在没备份的情况下放心登录 —— 属危险描述。
- 新增 `scripts/server/snapshot-db.mjs`（通用在线一致快照，自证行数一致）、
  `scripts/server/central-data-audit.mjs`（中央库数据缺口体检）、`scripts/inspect-sync-trigger.mjs`（同步触发器巡检）。

## 未发布 — 定价建议引擎（决策层 MVP-2）+ T1 工作树归位

### 定价建议引擎（MVP-2，2026-09-10）
- `electron/commands/pricing.js` → `buildPricing(db)`：纯规则·只读·零写入；照清仓引擎（MVP-1）同一模子。
  判据：毛利率 <15% → P1 毛利偏低（建议提价）；<0 → P0 亏本在售；>60% 且近 30 天无动销 → P2 可降价促动销。
  **降档护栏**：近 30 天有动销的高毛利品不做降价建议（护住收入）；**清仓品互斥**：已标记清仓的交给清仓引擎，不重复建议；
  无成本 / 无价不硬出。建议区间 = 单位成本 × {FLOOR[1.05,1.15], RAISE[1.35,1.60], CUT[1.10,1.25]}，**只给区间不给自动价**。
- 证据强弱如实标注：有带售价成交 → `basis='sales'`（成交中位价，强）；无成交 → 退用商品档案建议价 `basis='catalog'`（弱）；两者都无 → `dataWindowOk=false` 不硬出。
- 接线：`inv-analytics.mjs pricing`（CLI）/ IPC `pricing:get` / ReportsPage 定价建议卡（口径只走命令层，前端不复制规则）。
- 断言：`scripts/test-pricing.mjs` **23 条 fixture 全绿**；`test-backend.mjs` **611 条不破**；clearance fixture 8 条不回归。
- 渲染证据：`scripts/shot-pricing-card.cjs` → `screenshots/pricing-card-mvp2.png`（3 行、P0/P1/P2、零 pageerror）。

### T1 工作树归位（2026-09-10）
- 修掉一个**严重缺陷**：`electron/main.js` 早已 `import './aiQuota.js'` 与 `'./voiceOrderService.js'`，但这两个文件此前**未入库**
  → 干净 clone / `git checkout` 后 `ERR_MODULE_NOT_FOUND`，Electron 起不来（已用 HEAD 纯净导出 + node 解析实测证实）。
- 42 项未提交按功能流归位为 4 个 commit：语音开单 P1-3 / AI 计费额度 P0 / 云端优先恢复 / 手机页 A 线打磨；HEAD 现已自洽。
- 删除 3 个已被编码事故损坏且零引用的临时脚本（`_qcc-setup.mjs`/`_pwnet.mjs`/`_qcs.mjs`）。

## v1.0.9 (2026-09-09) — 同步增强 / 幂等键 / 清仓建议引擎

### 同步（70 -> 90 分，单店场景一分不差）
- **多设备云同步**：cloud.js -> sync.junchengzn.com AES-256 整库快照，多端同账。
- **中心库单一来源**：`/api/invoke`（app.junchengzn.com）与桌面/命令层同码；已部署验证（返回真实数据）。
- **写接口幂等键**：`/api/invoke` 写channel + `/api/outbound` 携带 `idempotencyKey`（每次逻辑操作唯一）→ 网络重试/双击/重发返回原结果，**不重复扣库存/记账**（堵'重复提交弄错钱'）；手机POS发稳定key；**611 断言全绿**。

### 清仓建议引擎（决策层 MVP-1）
- `inv-analytics.mjs clearance`：纯规则·只读·零写入，按 沉睡档(90/180天)×压货成本(≥500元)×临期(≤60天) → P0紧急清/P1应清/P2观察清；给出**建议区间**(成本×[0.6,0.85]等)而非自动改价；30天有动销降档护栏；无销售流水不硬出；fixture 8断言。
- ReportsPage 清仓建议卡 + 导出CSV（单一来源 `buildClearance`，命令层/CLI/IPC 同源）。

### P0 归一（默认中心库基础设施，live 迁移待 owner）
- `src/lib/api.ts` 中心库优先（rawBackend）；`CloudLoginGate` 登录即 `setCentralConfig`（默认切中心库入口）；`CloudCard` 识别 `centralOn`（多端同账中心库负责）。
- 受控迁移 Runbook 已写：备份 -> 灰度一台 -> 核对账实 -> 全量；live 翻转需门店桌面 + owner 授权。

### 发布 / 同步
- v1.0.9 发布：Setup 1.0.9.exe（自动更新源 + 官网下载 + docs）部署验证，公网 latest.yml=1.0.9、下载 200。
- GitHub：`ltmop/inventory-system` 已同步（84 提交 fast-forward）。

### 边界
- 进销存 `/api/pair` `/api/snapshot` `/api/backup*` 云同步未动；只做新增（幂等/single-source/建议引擎）。
- P0 归一的 live 翻转（现网桌面默认切中心库 + 迁现网账）待 owner 门店桌面环节执行。