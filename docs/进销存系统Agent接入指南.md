---
title: 通用进销存系统 Agent 接入指南
type: 项目文档
project: 进销存系统
category: Agent接入
version: 1.0
date: 2026-08-24
tags: [进销存, Agent, 接入指南, API, CLI, Skill]
status: 已发布
---

# 通用进销存系统 · Agent 接入指南

> 本文档面向**其他 AI Agent / 开发助手**，说明如何接入通用进销存系统：
> 在哪里读数据、怎么操作、有哪些现成 Skill 和 API 可用、边界约束是什么。
> 适合把进销存能力开放给其他创始人的 Agent（如经营助手、数据分析 Agent）。

---

## 一、系统全景（Agent 视角）

```
┌─────────────────────────────────────────────────────┐
│  通用进销存系统（两条产品线 + 云同步）                    │
│                                                     │
│  桌面端（Windows）          手机端（Android）           │
│  Electron+React+SQLite     Capacitor+sql.js          │
│  C:\...\AI智能管理进销存系统  D:\mobile-app-ading        │
│                                                     │
│  ┌─────────────┐        ┌──────────────────┐        │
│  │ 本地数据库     │        │ 云同步服务器         │        │
│  │ data.db      │        │ cloud-server      │        │
│  │ (SQLite/WAL) │        │ 43.128.20.39:80   │        │
│  └─────────────┘        └──────────────────┘        │
│                                                     │
│  CLI 工具：scripts/inv.mjs（脚本化云同步/备份/恢复）      │
│  Skills：inventory-system-usage/cli/install/dev       │
└─────────────────────────────────────────────────────┘
```

### 关键路径

| 资源 | 路径 |
|------|------|
| 桌面端项目 | `C:\Users\Administrator\Desktop\库存管理\AI智能管理进销存系统` |
| 手机端项目 | `D:\mobile-app-ading` |
| 云服务器 | 腾讯云 43.128.20.39（http://43.128.20.39） |
| 本地数据库 | `%APPDATA%\fishing-inventory\data.db`（SQLite/WAL） |
| CLI 工具 | `scripts/inv.mjs` |
| 知识库文档 | `D:\A1-AI知识库\70-进销存系统项目\` |
| Agent Skills | `D:\A1-AI知识库\70-进销存系统项目\skills\` |

---

## 二、Agent 可用的现成 Skill

系统已注册 4 个进销存 Skill（在 `~/.claude/skills/` 和知识库 70 项目均有副本）：

| Skill | 触发 | 用途 | 适合场景 |
|-------|------|------|---------|
| `inventory-system-usage` | /进销存怎么用 | 使用运维指引 | 回答"怎么开单/入库/备份" |
| `inventory-system-cli` | /CLI同步 | CLI 与云同步 | 脚本化同步/部署/API |
| `inventory-system-install` | /安装进销存 | 下载安装打包 | 装软件/打包/迁移 |
| `inventory-system-dev` | /改进销存 | 开发改造 | 加功能/修bug/迁移 |

> 接入方式：Agent 把 `SKILL.md` 加载进上下文，或调用对应 Skill 名称。
> 建议组合使用：经营问答（usage）+ 数据操作（cli）+ 系统维护（install/dev）。

---

## 三、数据读取（Agent 能看什么）

### 3.1 本地数据库（只读推荐）

数据库：`%APPDATA%\fishing-inventory\data.db`（SQLite，node:sqlite 可读）

核心表：

| 表 | 内容 | 常用字段 |
|----|------|---------|
| products | 商品 | sku_code, category, brand, model, cost_price(分), suggest_price(分), unit, status |
| inventory_batches | 库存批次 | product_id, batch_no, quantity, cost_price, expiry_date |
| transactions | 流水 | product_id, type(in/out/return/exchange/waste), quantity, unit_price, selling_price, timestamp |
| customers | 客户 | name, phone, member_no, level, price_level |
| suppliers | 供应商 | name, contact, phone |
| expenses | 支出 | category, amount(分), expense_date |
| kits | 组合商品 | name, price, discount_percent |
| price_tiers | 价格档 | product_id, tier(retail/member/wholesale), price |

> **价格一律是"分"（整数）**，显示时 ÷100。金额计算禁止浮点。

### 3.2 只读查询示例（node）

```js
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(process.env.APPDATA + '\\fishing-inventory\\data.db')
// 今日营业额
const row = db.prepare(
  "SELECT SUM(selling_price*quantity) AS rev FROM transactions WHERE type='out' AND date(timestamp)=date('now')"
).get()
console.log('今日营业额(分):', row.rev)
db.close()
```

> ⚠️ 只读查询用 `new DatabaseSync(path, { readOnly: true })` 更安全。

### 3.3 云端数据（远程读）

云服务器 `http://43.128.20.39` 存**加密快照 + 备份**（AES-256-GCM），
Agent 不能直接读明文（密钥只在本机）。要读经营数据请走本地库或 CLI 同步后读本地。

---

## 四、操作入口（Agent 能做什么）

### 4.1 CLI（推荐，脚本化）

工具：`node scripts/inv.mjs`

| 命令 | 用途 |
|------|------|
| `status` | 看云同步状态 |
| `sync` | 手动同步快照 |
| `backup` | 上传整库备份 |
| `backups` | 列云端备份 |
| `restore --date YYYY-MM-DD` | 从云端恢复 |
| `register/login` | 账户管理（一般不用 Agent 做） |

### 4.2 云服务器 HTTP API（远程操作）

Base: `http://43.128.20.39`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/account/register | 注册账户 |
| POST | /api/account/login | 登录 |
| POST | /api/device/bind | 绑定设备（多电脑） |
| POST | /api/snapshot | 上传快照 |
| POST | /api/backup | 上传备份 |
| GET | /api/backup/list | 列备份 |
| GET | /api/backup/download?date= | 下载备份 |
| GET | /v/{viewToken} | 远程看店页 |

鉴权：设备 `uploadToken` 放 `x-token` 头。

### 4.3 桌面端 IPC（本机 GUI 操作）

桌面端通过 IPC（preload 暴露 `window.fi.invoke(channel, payload)`）操作。
Agent 若要自动化 GUI 操作，可用 Playwright 驱动 Electron（参考 scripts/test-electron.cjs）。

---

## 五、Agent 接入步骤（5 分钟）

### Step 1：确认环境
- [ ] 项目路径存在（桌面端/手机端）
- [ ] 本地数据库可读（%APPDATA%\fishing-inventory\data.db）
- [ ] CLI 可用：`node scripts/inv.mjs help`
- [ ] 云服务器可达：`http://43.128.20.39`

### Step 2：选接入方式

| 我要做什么 | 用哪个 |
|-----------|--------|
| 回答经营问题（卖多少/毛利/库存） | 本地库只读查询 |
| 同步/备份/恢复 | CLI（inv.mjs） |
| 远程经营看板 | 云 API + 看店页 |
| 修改系统/加功能 | inventory-system-dev Skill |
| 打包/部署 | inventory-system-install Skill |

### Step 3：注册为"设备"（如需云同步）

```bash
node scripts/inv.mjs config --server http://43.128.20.39
node scripts/inv.mjs login --username <团队账户> --password <密码>
node scripts/inv.mjs status   # 验证
```

---

## 六、边界与约束（Agent 必须遵守）

| 约束 | 说明 |
|------|------|
| **只读优先** | 经营数据查询走本地库只读，别乱写 |
| **价格用分** | 所有金额字段是"分"整数，禁止浮点运算 |
| **不删数据** | 删除商品/客户/流水是危险操作，须人工确认 |
| **统计口径** | 以桌面端 `electron/commands/` 为准，别另写 SQL 算口径 |
| **云数据加密** | 云端只见密文，别尝试读明文 |
| **迁移安全** | 改库必须 ALTER TABLE 迁移 + 备份兜底 |
| **打包纪律** | 打包期间不动代码（dist 会被重建） |
| **权限** | 员工/创始人权限区分，Agent 操作需对应用户身份 |

---

## 七、常用查询速查（Agent 高频）

### 今日经营
```sql
-- 今日营业额（分）
SELECT SUM(selling_price*quantity) FROM transactions
WHERE type='out' AND date(timestamp)=date('now');
-- 今日毛利（分）
SELECT SUM((selling_price-unit_price)*quantity) FROM transactions
WHERE type='out' AND date(timestamp)=date('now');
```

### 库存预警
```sql
-- 低库存（库存 ≤ 缺货线）
SELECT p.sku_code, p.brand, p.model, COALESCE(SUM(b.quantity),0) AS stock
FROM products p LEFT JOIN inventory_batches b ON b.product_id=p.id
GROUP BY p.id HAVING stock <= COALESCE(p.min_stock, 5);
-- 临期（30 天内到期）
SELECT p.sku_code, b.batch_no, b.quantity, b.expiry_date
FROM inventory_batches b JOIN products p ON p.id=b.product_id
WHERE b.quantity>0 AND b.expiry_date IS NOT NULL
  AND b.expiry_date <= date('now','+30 days');
```

### 客户欠款
```sql
SELECT c.name, c.member_no,
  COALESCE(SUM(t.selling_price*t.quantity - COALESCE(t.paid_amount,t.selling_price*t.quantity)),0) AS debt
FROM customers c JOIN transactions t ON t.customer_id=c.id AND t.type='out'
GROUP BY c.id HAVING debt > 0;
```

---

## 八、故障排查（Agent 遇到问题）

| 问题 | 处理 |
|------|------|
| 连不上云服务器 | ping 43.128.20.39；`pm2 status inventory-cloud`（需 SSH） |
| 本地库打不开 | 确认 WAL 已 checkpoint；用只读模式重试 |
| CLI 报"未绑定设备" | 先 login |
| 价格显示不对 | 确认 ÷100（分→元） |
| 想改系统 | 加载 inventory-system-dev Skill，走完整流程 |

---

## 相关文档

- [[进销存系统使用指南]]
- [[进销存系统CLI接入指南]]
- [[进销存系统下载文档]]
- [[创始团队云同步接入说明]]
- [[../30-AI技术积累/渔具进销存系统架构|进销存系统架构]]

## 更新日志

- 2026-08-24：创建，面向其他 Agent 的接入指南（系统全景/数据读取/操作入口/边界约束/常用查询）
