# 运维 Runbook · 备份与恢复（B1）

> 建立日期：2026-09-12　适用：进销存中央库（`/opt/inventory-app`，生产机 43.128.20.39）
> 目的：让**任何一个人**（包括下一位编程 Agent）都能独立完成"确认备份在跑 / 手动备份 / 从备份恢复 / 排障"。
> 所有数字都是**实测值**，不是设计目标；未实测的部分在 §7 明确标出。

---

## 1. 一句话

> 🔴 **2026-09-13 20:20 起：「5 分钟快照」与「第二位置」已按 owner 要求停用**（理由、影响、恢复办法见 §2.1）。
> **当前唯一在跑的自动备份 = 每天 03:30 的天级备份**（`/opt/inventory-app/backups/`，同机同盘、无异地副本）
> ⇒ 数据损坏最多丢 **24 小时**；整机丢失则**没有任何异地副本**。
>
> 下面这句是**停用前**的状态，保留作对照：中央库曾有**三层备份 + 一个第二位置**，数据损坏最多丢 **5 分钟**；从备份恢复到服务可用，实测 **0.44 秒**（但"换一台新服务器"这一段没测，见 §7）。

---

## 2. 总览（先看这张表）

| 层级 | 产物位置 | 频率 | 保留 | 谁在做 | 状态 |
|---|---|---|---|---|---|
| **天级** | 服务器 `/opt/inventory-app/backups/central-YYYYMMDD.db` | 每天 03:30 | 最近 14 天 | cron `30 3` → `backup-central.mjs`（原有） | ✅ **唯一在跑** |
| **5 分钟快照** | 服务器 `/opt/inventory-app/backups-5min/central-YYYYMMDD-HHMM.db` | 每 5 分钟 | 最近 36 份（3 小时） | cron `*/5` → `central-snapshot.mjs` | ⛔ **2026-09-13 20:20 起停用** |
| **小时级** | 服务器 `/opt/inventory-app/backups-hourly/` | 每小时（整点后 5 分钟内那次） | 最近 24 份（1 天） | 同一个脚本 | ❌ **从来没成功过**（见 §2.2） |
| **第二位置** | 本机 `D:\服务器备份\进销存中央库\` | 每 15 分钟拉取 | 快照 96 份 / 日备 14 份 | Windows 计划任务 `DSH-Inventory-CentralBackupPull` | ⛔ **2026-09-13 20:20 起停用** |

### 2.1 停用记录（2026-09-13，owner 要求）

owner 原话：「把进销存每10分钟的自动数据备份程序停了」。实测**没有任何进销存备份任务是 10 分钟周期**，
唯一精确 10 分钟的是驾驶舱的 `cockpit-sync`（不属于进销存）；把候选摆清后 owner 选择 **「两个都停」**：

| 停了什么 | 怎么停的 | 怎么恢复 |
|---|---|---|
| 服务器 5 分钟快照 | `crontab` 第 4 行前加 `# DISABLED-2026-09-13-by-owner-request `（**注释，不是删除**）；改动前已备份到 `/home/ubuntu/crontab.bak-20260913-202054` | `ssh juncheng "crontab ~/crontab.bak-20260913-202054"` |
| 本机第二位置拉取 | `Disable-ScheduledTask -TaskName DSH-Inventory-CentralBackupPull`（**禁用，不是删除**；任务定义与历史都还在） | `Enable-ScheduledTask -TaskName DSH-Inventory-CentralBackupPull` |

**停用后的真实风险（必须知道）**：进销存只剩**一级**自动备份 —— 每天 03:30 的 `backups/central-YYYYMMDD.db`，
**同机同盘**。也就是说：盘坏 / 整机没了 → **备份跟着一起没，没有任何异地副本**；
数据误改误删 → 最多要回退 **近 24 小时**（原来是 5 分钟）。

**已有产物不会被删**：`backups-5min/` 里 36 份、本机 `D:\服务器备份\进销存中央库\` 里的历史快照都还在原地，
只是不再新增。要回滚到历史某个时间点，仍然可以用它们。

### 2.2 顺带查出：小时级备份从来没成功过（既有缺陷）

`central-snapshot.mjs` 每小时会尝试从 5 分钟快照生成一份小时级备份（脚本第 92 行），
但 **`/opt/inventory-app/backups-hourly/` 这个目录根本不存在**，`snapshot.log` 里每小时都在报同一类错：

```
Error: ENOENT: no such file or directory, copyfile
  '/opt/inventory-app/backups-5min/central-20260912-2200.db' -> '/opt/inventory-app/backups-hourly/central-20260912-22.db'
    at file:///opt/inventory-app/central-snapshot.mjs:92:6
```

成功日志里 `keptHourly` 始终是 `null` ⇒ **这一层从上线起就没工作过**（既有缺陷，不是本次停用造成的）。
上面那张表原先把它写成"每小时 / 保留 24 份（1 天）"，属**文档与事实不符**，本次一并订正。
这也说明 §7 第 4 条那个"整点后 5 分钟内没跑到就没有小时级快照"是**把一个更严重的问题误诊成了偶发**。

**为什么要第二位置**：上面几层**都在服务器同一块盘上**。盘坏或整机没了两者一起没 —— 这也是当初建第二位置的原因；
现在它已停用，所以这条保护**当前是缺的**（见 §7.2）。

**脚本源码都在仓库里**（别只留服务器上：服务器没了，备份工具也跟着没）：

| 脚本 | 仓库位置 | 跑在哪 |
|---|---|---|
| 5 分钟快照 | `scripts/server/central-snapshot.mjs` | 服务器 `/opt/inventory-app/central-snapshot.mjs` |
| 恢复演练 | `scripts/server/restore-drill.mjs` | 服务器 `/opt/inventory-app/restore-drill.mjs` |
| 第二位置拉取 | `scripts/pull-central-backup.mjs` | 本机 |

改完这些脚本要重新上传到服务器并 `node --check`（2026-09-12 核对过：仓库副本与服务器版 sha256 一致）。

连接方式：`ssh juncheng`（`~/.ssh/config` 已配：43.128.20.39 / ubuntu / `skey-junchengzn.pem`）。

---

## 3. 三层备份的关键设计（为什么这么写）

- **用 `VACUUM INTO`，不是 `cp`**。直接用 `cp` 拷"活着的" SQLite 文件，在 WAL 模式下可能拿到**撕裂/不一致快照**；`VACUUM INTO` 由 SQLite 保证一致性，并自动包含 WAL 里尚未 checkpoint 的写入。
- **每份快照都做完整性自检**（`PRAGMA integrity_check` + `products` 计数）。备份不校验 = 不知道自己有没有备成功。**校验不过就保留现场、不参与轮转、退出码非 0**，让 cron 日志能暴露出来。
- **第二位置拉下来就就地校验**（同样跑 `integrity_check` + 关键表计数）。「文件在」不等于「能恢复」；校验不过 `exit 1`。
- **保留策略是显式的**，会自动删旧的，不会只涨不删。

---

## 4. 恢复流程（按场景照抄命令）

### 场景 A：数据被误改/误删，要回滚到某个时间点

先挑一份**事故发生之前**的备份：

> ⛔ **`backups-5min/` 自 2026-09-13 20:20 起不再新增**（见 §2.1）。**现在唯一在增长的是天级备份**：
>
> ```bash
> ssh juncheng "ls -la /opt/inventory-app/backups/ | tail -20"
> ```
>
> 三小时内的事故仍可在 `backups-5min/` 冻结的 36 份历史快照里找，但那个目录不会再有新文件。
>
> ⚠️ **`restore-drill.mjs` 现在还演练不了天级备份**：它的快照名正则只认 `central-YYYYMMDD-HHMM.db`（5 分钟级），
> 认不出天级的 `central-YYYYMMDD.db`。所以演练目前只能对上冻结的 5 分钟快照（见 §7）。

```bash
ssh juncheng "ls -la /opt/inventory-app/backups-5min/ | tail -20"
```

> ⚠️ 一定要挑**在误操作之前**的那一份。宁可多往回退几分钟，也别用最新的。

**不用动生产机也能先验证这份快照好不好**（强烈建议先做这一步）——
演练脚本支持直接指定某一份快照，它会恢复、校验、并起一个**非生产实例**验证真的能服务：

```bash
ssh juncheng "/opt/node22/bin/node --experimental-sqlite /opt/inventory-app/restore-drill.mjs /opt/inventory-app/backups-5min/<快照文件名>"
```

看输出里的 `integrity` 是否为 `ok`、`restoredMatchesProd` 是否为 `true`。不传路径则默认用最新那份。

确认没问题后再回滚（**回滚前先备份当前的坏库**）：

```bash
ssh juncheng 'set -e
  cd /opt/inventory-app/data
  TS=$(date +%Y%m%d-%H%M%S)
  sudo cp -a data.db      data.db.before-rollback-$TS
  sudo cp -a data.db-wal  data.db-wal.before-rollback-$TS 2>/dev/null || true
  # 用 VACUUM INTO 出来的快照直接替换（它是完整一致的库，不需要 WAL 一起拷）
  sudo rm -f data.db-wal data.db-shm
  sudo cp -a /opt/inventory-app/backups-5min/<快照文件名> data.db
  sudo chown ubuntu:ubuntu data.db
  pm2 restart inventory-app'
```

回滚后**必须验证**：

```bash
ssh juncheng "curl -s -o /dev/null -w 'app=%{http_code}\n' http://127.0.0.1:3200/ ; \
  curl -s -o /dev/null -w 'm=%{http_code}\n' http://127.0.0.1:3200/m"
```

### 场景 B：服务器上的库文件损坏

同上，但优先用**天级备份**（更早、更稳）：

```bash
ssh juncheng "ls -la /opt/inventory-app/backups/ | tail -20"
```

然后照场景 A 的"回滚"步骤替换 `data.db`。

### 场景 C：服务器整机没了（换新机）

用**第二位置**那份（本机）：

```powershell
Get-ChildItem "D:\服务器备份\进销存中央库" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
```

完整流程需要：申请/重装服务器 → 装 Node22 与依赖 → 把仓库代码部署上去 → 上传选定的 `.db` 到 `/opt/inventory-app/data/data.db` → 起 `pm2` → 配 Caddy/DNS/证书。
**其中"装环境 + 部署 + DNS"这一段目前没有实测过，也没有 RTO 目标**（见 §7）。

---

## 5. 实测数字（用于对外承诺时引用）

| 指标 | 实测值 | 说明 |
|---|---|---|
| 中央库大小 | 约 384 KB（`data.db` 393216 B + `data.db-wal` 约 226 KB） | 库很小，所以 5 分钟一次成本可忽略 |
| 单次 5 分钟快照耗时 | **39 ms**（含 `VACUUM INTO` + 完整性自检） | 不含 node 启动；含启动 97 ms |
| 恢复演练 · 拷贝快照 | **0 ms** | 413696 B |
| 恢复演练 · 校验 | **6 ms** | `integrity_check` + 计数 |
| 恢复演练 · 起服务并对外响应 | **424 ms** | 随机端口 + 独立 dataDir，**非生产实例** |
| **恢复演练 · 合计** | **435 ms**（含 node 启动 538 ms） | 恢复出的库 `products`/`transactions`/`suppliers` 与生产库**逐项相同** |
| RPO · 数据损坏场景 | **≤ 24 小时**（原 **≤ 5 分钟**） | ⛔ 5 分钟快照 2026-09-13 停用；现由每天 03:30 的天级备份保证 |
| RPO · 整机丢失场景 | **无副本 = 不可恢复**（原 **≤ 15 分钟**） | ⛔ 第二位置 2026-09-13 停用；且天级备份与生产库**同机同盘** |
| RTO · 数据+服务恢复 | **0.44 秒 / 0.88 秒** | 两次演练的实测值（435ms / 878ms），随机器负载浮动 |
| RTO · 换新服务器端到端 | **未测** | 见 §7 |

---

## 6. 日常运维速查

> ⛔ 2026-09-13 停用之后，下面那些「快照 / 第二位置」命令多数只剩**查看冻结历史**之用，
> 不再能回答"有没有在跑"。**现在真正该盯的是天级备份**：

```powershell
# 【现在唯一在跑的】天级备份有没有成功？（看最后两行）
ssh juncheng "tail -4 /opt/inventory-app/data/backup.log"

# 【现在唯一在跑的】天级备份有哪些 / 占多大
ssh juncheng "ls -la /opt/inventory-app/backups/ | tail -20; du -sh /opt/inventory-app/backups"

# 【已停用】第二位置计划任务状态：Disabled = 已停，符合预期
Get-ScheduledTask -TaskName DSH-Inventory-CentralBackupPull | Select-Object State
```

以下保留作**排障 / 恢复 / 演练**用：

```powershell
# 快照到底在不在跑？（看最后几行时间戳）
ssh juncheng "tail -5 /opt/inventory-app/data/snapshot.log"

# 现有多少份快照 / 占多大
ssh juncheng "ls /opt/inventory-app/backups-5min | wc -l; du -sh /opt/inventory-app/backups*"

# 手动立刻做一次快照
ssh juncheng "/opt/node22/bin/node --experimental-sqlite /opt/inventory-app/central-snapshot.mjs"

# 手动跑一次恢复演练（非生产，安全）
ssh juncheng "/opt/node22/bin/node --experimental-sqlite /opt/inventory-app/restore-drill.mjs"

# 手动拉一次第二位置（会就地校验）
cd "C:\Users\Administrator\Desktop\库存管理\AI智能管理进销存系统"
node scripts/pull-central-backup.mjs

# 第二位置计划任务状态（LastTaskResult 应为 0）
Get-ScheduledTaskInfo -TaskName DSH-Inventory-CentralBackupPull

# 第二位置拉取日志
Get-Content "D:\服务器备份\进销存中央库\_pull.log" -Tail 20
```

**想改拉取频率**：改计划任务的 trigger（不要用 `.cmd` 包装，中文路径会被 cmd.exe 的 ANSI 解析搞坏）：

```powershell
$trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
Set-ScheduledTask -TaskName DSH-Inventory-CentralBackupPull -Trigger $trg
```

**想换第二位置**（例如换到对象存储/另一台服务器）：只改环境变量 `PULL_DIR` 或脚本顶部的常量即可，逻辑不用动。

---

## 7. ⚠️ 已知边界与未决项（对外承诺前必须知道）

0. 🔴 **当前 RPO = 24 小时，且没有任何异地副本**（2026-09-13 停用了 5 分钟快照与第二位置，见 §2.1）。
   对外承诺「最多丢 5 分钟」**已经不成立** —— 那句话依赖的 5 分钟快照已停用。
   要恢复这层保护，照 §2.1 表里的恢复命令做（都是一条命令，禁用/注释而已，没删东西）。
1. **RTO 目标仍未确认**。老板只给了 RPO=5 分钟。§5 里的 0.44 秒**只是"恢复数据 + 起服务"这一小段**；真正的灾难恢复还包含申请/重装服务器、装运行时、部署代码、配 Caddy/DNS/证书 —— **那部分没测、也没有目标可比**。已发问卷等老板给一个数。
2. **第二位置依赖本机开机**。计划任务是 `Logon Mode = Interactive only`：**关机或未登录就不会拉**。所以"整机丢失"场景的有效 RPO = 距最后一次成功拉取的时间，**不是 5 分钟**。真正的异地（对象存储/另一台常在线的服务器）要等老板拍板。
3. ⛔ **原来那条兜底已经没了**：原文写「服务器上的三层备份同盘；盘坏时只剩本机那份」——
   但第二位置已停用（§2.1），**现在盘坏或整机丢失就是全没**，没有"只剩本机那份"这一说。
4. ❌ **小时级备份从未成功过**（原文档误写成"整点没跑到就偶发缺失"）：`backups-hourly/` 目录根本不存在，
   脚本第 92 行每小时 ENOENT，`keptHourly` 恒为 `null`。详见 §2.2。
5. **恢复演练起的是非生产实例**（随机端口 + 独立 `dataDir`），不会碰生产数据；演练产生的临时目录会自动清理。
6. 演练日志里会出现 `HTTPS 启动失败（listen EACCES 0.0.0.0:1）` —— 这是演练用 `basePort: 0` 的副产物，**不是产品缺陷**。

---

## 8. 给下一位 Agent 的交接要点

- 备份相关的脚本三个，**源码都在仓库**：`scripts/server/central-snapshot.mjs`、`scripts/server/restore-drill.mjs`（这两个要部署到服务器 `/opt/inventory-app/`）、`scripts/pull-central-backup.mjs`（本机跑）。见 §2。
- **不要用 `.cmd` 包装计划任务**，也不要用 `schtasks /tr` 拼带引号又带中文的命令行（中文会被 cmd.exe 按 ANSI 读成乱码）。用 `New-ScheduledTaskAction` / `Register-ScheduledTask`。
- **在计划任务（非交互会话）里跑 ssh，必须把子进程 stdin 关掉**：Node 里 `spawnSync(..., { stdio: ['ignore','pipe','pipe'] })`，否则 ssh 会一直等输入而卡死（现象是任务 `LastTaskResult=267009` 一直"运行中"、脚本日志一行不写）。
- 判断自动化有没有真跑通，**看脚本自己写的日志**，不要只看 `LastTaskResult=0`（那个可能是骗人的）。
- 服务器磁盘曾到 89%：元凶是 5 个 `inventory-cloud.bak-*` 各存了一整套桌面安装包（每个约 2.8G，而活的 `/opt/inventory-cloud/updates` 里本来就有）。2026-09-12 已清理到 44%，清理原则是"**只删活目录里已有同名的文件**"，活目录没有的一律保留。
