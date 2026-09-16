---
title: 通用进销存系统 · Agent 接入指南
type: 项目文档
project: 进销存系统
category: Agent接入
version: 2.0
date: 2026-09-16
tags: [进销存, Agent, 接入指南, API, CLI]
status: 已发布
---

# 通用进销存系统 · Agent 接入指南（v2）

> 面向**要操作这套进销存的 AI Agent / 脚本 / 开发助手**。目标是**5 分钟跑通第一条命令**。
> 本文里的每个数字与路径都由闸门 `scripts/verify-command-api.mjs` 守着（见文末「本文怎么防腐」），
> 不是手抄的。
>
> 一句话版本：**先 `GET /api/commands` 看有什么能调，再 `POST /api/invoke` 调它；只读随便跑，写命令加 `--yes`。**

---

## 〇、最快上手（复制就能跑）

```bash
# 1) 本机应用要开着（它是服务端）。令牌在这里：
#    Windows: %APPDATA%\fishing-inventory\server-token.txt  （32 位十六进制）

# 2) 看有哪些命令能调（只读，不需要确认）
node scripts/inv-cli.mjs list --readonly

# 3) 挑一条只读命令直接跑（不需要 --yes）
node scripts/inv-cli.mjs run product:list --params '{"keyword":"","limit":5}'

# 4) 看某条命令的完整用法（说明 / 读写 / 范围 / 示例）
node scripts/inv-cli.mjs doc stock:transfer

# 5) 写命令（会改账）必须显式确认
node scripts/inv-cli.mjs run stock:transfer --params '{"productId":1,"quantity":2,"toLocation":"A墙"}' --yes
```

> Windows 下 `--params` 里的引号容易被命令行吃掉 → 参数长就写文件：`--params-file params.json`。

---

## 一、系统长什么样（Agent 视角）

```
                   ┌──────────────────────────────────────────┐
   你（Agent） ───▶ │  进销存服务端（本机 17532 / 中心库 3200） │
   三条通道         │  · 业务实现全在 electron/commands/**      │
                   │  · 数据在 SQLite（WAL）                  │
                   └──────────────────────────────────────────┘
```

| 概念 | 说明 |
|---|---|
| **服务端在哪** | 桌面机：`http://127.0.0.1:17532`（「设置 → 手机看店」能看到地址与端口）。中心库模式：门店那台服务器的 `app.junchengzn.com` / `IP:3200` |
| **鉴权** | 一律 `x-token: <令牌>`（也接受 `?token=`）。缺令牌或错令牌 → **HTTP 401** |
| **业务口径在哪** | **只在命令层**（`electron/commands/**`）。HTTP/CLI/桌面界面都只是它的入口 —— 所以 Agent 走接口拿到的数字，与界面里看到的**同源** |
| **命令自省** | `GET /api/commands` 是唯一权威清单（含说明、读写标记、是否本机专属）。当前 **191** 条命令（45 个前缀），其中 **92** 条只读 |

---

## 二、三条通道（同一套命令，选一条顺手的）

### 通道 0：**先问它自己**（最省事，推荐第一步）

```
GET /api/agent
```

一次拿全：这是什么系统、**怎么鉴权**、有哪几条路能走（含可复制的示例）、
**只读清单 / 写命令清单 / 本机专属清单**、以及文档在哪。
返回里的 `counts` 与三份清单都是**从注册表现算**的，所以不会像手写文档那样过期。

### 通道 A：自省（只读，先看有什么）

| 请求 | 用途 |
|---|---|
| `GET /api/commands` | 全部命令（带 `desc` / `write` / `local` / `ipc` / `http`） |
| `GET /api/commands?group=product` | 只看某一组 |
| `GET /api/commands?q=库存` | 按关键字搜（匹配命令名与说明） |
| `GET /api/commands?name=stock:transfer` | 单条详情：说明、读写、范围、示例 |

### 通道 B：通用调用（能调任何命令）

```
POST /api/invoke     body {"channel":"<命令名>","payload":{...}}
POST /api/command    body {"name":"<命令名>","params":{...}}      # 同一个入口，另一种名字风格
Header: x-token: <令牌>   Content-Type: application/json
```

- 成功：`{"ok":true,"result":...}`
- 业务失败：**HTTP 400** + `{"ok":false,"error":"中文原因"}`（比如"商品不存在"）
- 未知命令：**HTTP 404**
- 幂等：body 里带 `idempotencyKey`，同一 key 重发第二次返回 `idempotent:true`（不会重复改账）

### 通道 C：只读 REST（适合看板 / 定时巡检，不用记命令名）

```
GET /api/agent                自描述入口（通道 0，推荐第一步）
GET /api/summary              今日概览（SKU / 件数 / 库存值 / 低库存数）
GET /api/low-stock            低库存清单
GET /api/inventory?q=         库存查询（可按关键字）
GET /api/today                今日流水
GET /api/customers            客户列表（含欠款）
GET /api/audit                操作日志（最近 50 条）
GET /api/supplier-statement?id=  供应商对账单
GET /api/analytics/overview   经营概览（今日/本月 营业额毛利 + 库存额 + SKU + 低库存）
GET /api/analytics/trend?days=7      近 N 天趋势
GET /api/analytics/category          分类销售
GET /api/analytics/top?n=10          TOP N
GET /api/analytics/stockValue        库存金额
GET /api/backup/list          中心库服务端每日备份列表
GET /api/commands             命令自省
```

### 通道 D：CLI（脚本/自动化最省事）

```bash
node scripts/inv-cli.mjs guide                      # 接入说明（离线可读）
node scripts/inv-cli.mjs list [--group X] [--q 词] [--readonly|--writes] [--json]
node scripts/inv-cli.mjs groups
node scripts/inv-cli.mjs doc <命令名> [--json]
node scripts/inv-cli.mjs run <命令名> [--params '<JSON>' | --params-file <文件>] [--yes]
```

连接参数（命令行 > 环境变量 > 默认）：`--url` / `INV_URL`（默认 `http://127.0.0.1:17532`）、
`--token` / `INV_TOKEN`（默认读本机 `server-token.txt`）、`--out <文件>`（同时写文件，方便脚本读）。

---

## 三、只读 vs 写：Agent 必须知道的规则

注册表给每条命令标了 `write`：

| 标记 | 含义 | 例子 |
|---|---|---|
| `write: false`（**只读**） | 只查不改，**可以直接跑** | `product:list`、`analytics:overview`、`customer:list` |
| `write: true`（**写**） | 会改账 / 改库 / 改本机文件或配置，CLI **必须加 `--yes`** | `inbound:create`、`product:update`、`stock:transfer`、`cloud:restore` |
| `local: true`（**本机专属**） | 问的是"这台电脑"（AI Key、备份目录、语音模型…），**只在桌面机上能调**，中心库/手机打不到 | `ai:setKey`、`backup:restore`、`tts:speak` |

**CLI 的三条铁律**（都有断言守着）：
1. 拿不到 `write` 标记（老版本服务端、或命令不在表里）→ **一律按写处理**，仍要 `--yes`；
2. 拒绝发生在**发写请求之前**；
3. `--yes` 永远能跑（人要显式确认时不受标记影响）。

**给 Agent 的建议**：默认只调 `write: false` 的命令；要改账时**先把动作和参数汇报给人**，拿到同意再加 `--yes`。
`list --readonly` 就是"安全清单"。

---

## 四、常见任务配方（可直接复制）

```bash
# 看今天怎么样
node scripts/inv-cli.mjs run analytics:overview

# 查商品（按关键字）
node scripts/inv-cli.mjs run product:search --params '{"keyword":"伞"}'

# 低库存清单
curl -s -H "x-token: $TOKEN" http://127.0.0.1:17532/api/low-stock

# 客户欠款
node scripts/inv-cli.mjs run customer:list

# 热销榜（近 30 天）
node scripts/inv-cli.mjs run report:hotSellers --params '{"days":30}'

# 入库（写 —— 参数形状用 doc 看）
node scripts/inv-cli.mjs doc inbound:create
node scripts/inv-cli.mjs run inbound:create --params-file inbound.json --yes

# 库位调拨（写，不写 transactions、不影响营业额）
node scripts/inv-cli.mjs run stock:transfer --params '{"productId":1,"quantity":2,"fromLocation":"优选仓","toLocation":"A墙"}' --yes

# 新增商品（写，会校验 SKU 额度）
node scripts/inv-cli.mjs doc product:create
```

> ⚠️ 写命令的**参数形状**不要猜：`doc <命令名>`（或 `GET /api/commands?name=<命令名>`）会给说明与示例。
> 本文只对已核过的只读命令写了确切参数。

---

## 五、排错对照

| 现象 | 原因 / 怎么办 |
|---|---|
| `HTTP 401` | 令牌不对。从 `%APPDATA%\fishing-inventory\server-token.txt` 取；中心库模式要用**中心库那台**的令牌 |
| `连不上 127.0.0.1:17532` | 应用没开，或「设置 → 手机看店」的服务没启动 |
| `HTTP 404 unknown channel` | 命令名打错，或这台服务端版本没有这条命令 → `list --q <关键词>` 找准确名字 |
| `返回不是 JSON` | 打到别的服务了（端口错），或反代把它换成了 HTML 错误页 |
| `--params 不是合法 JSON` | Windows 吞引号 → 改用 `--params-file` |
| 命令**跑不动且没提示** | 用 `doc` 看它是不是 `local: true`（本机专属，中心库/手机打不到） |

---

## 六、安全与边界（诚实版）

1. **令牌就是钥匙**：它是明文 bearer，能读账也能改账。**不要**写进代码仓库、日志、聊天记录。
2. **写命令会真的改账**。Agent 的默认姿势应该是"只读 + 报告建议"，改账前先要人点头。
3. **本机专属通道**（`local: true`）只能在这台桌面机上调；走中心库打不到它们。
4. **中心库模式下**：桌面机与中心库服务器是**两台机器两套令牌**，别混用。
5. 本指南**不覆盖**：手机端 APP、云同步的账号/租户接口（那些是另一套，见 `docs/计费系统-接口文档.md` 等）。

---

## 七、接口文档与命令全集在哪

| 文档 | 内容 | 是否自动生成 |
|---|---|---|
| `docs/命令接口-接口文档.md` | **命令全集**（按前缀分组，含说明/读写/本机）+ 三条通道示例 | ✅ 生成物（勿手改） |
| `docs/进销存数据分析接口.md` | 分析类接口（趋势/分类/TOP/库存额） | 手写 |
| 本文 | 接入路径与配方 | 手写（有断言防腐） |

重新生成命令文档（改了命令层之后）：

```bash
node scripts/command-surface.mjs --emit-registry   # 1) 从代码抽取 → 注册表
node scripts/gen-command-doc.mjs                   # 2) 注册表 → 接口文档
node scripts/gen-command-doc.mjs --check           # 3) 校验文档与注册表一致（不一致即失败）
node scripts/verify-command-api.mjs                # 4) 起真服务端验收命令接口
```

---

## 八、本文怎么防腐

上一版（v1，2026-08-24）烂掉的原因很朴素：**它提的入口是旧的、还提了一个不存在的脚本，而没有任何断言盯着它**。
这一版由 `scripts/verify-command-api.mjs` 的断言守着：

- 本文提到的**每个 `scripts/*.mjs` / `docs/*.md` 路径必须真实存在**（写错/删了就红）；
- 本文声明的**命令总数必须等于注册表里的真实条数**；
- 本文必须提到三条真实入口（`/api/commands`、`/api/invoke`、`inv-cli.mjs`）与**写命令要 `--yes`** 这条规则。

改代码后如果这些对不上，闸门会红 —— 逼着改文档，而不是让文档慢慢变成传说。
