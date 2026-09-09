# 进销存系统 CHANGELOG

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