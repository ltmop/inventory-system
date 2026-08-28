# 通用进销存 CLI 接入指南

命令行工具 `scripts/inv.mjs` 让进销存系统支持**脚本化云同步与数据管理**，也是**一个账户多台电脑**的接入入口。

## 一、快速开始（3 步接入云同步）

### 第 1 步：启动云服务器（一次，部署方执行）

```bash
cd cloud-server
# 方式 A：前台启动（开发/临时）
node index.js
# 或双击 start-cloud.bat

# 方式 B：后台常驻（生产，需 pm2）
npm install -g pm2
pm2 start index.js --name inventory-cloud --env PORT=3100 --env ADMIN_KEY=你的管理密钥
pm2 save
```

默认端口 3100，数据存 `cloud-server/data/`。环境变量：
- `PORT`：端口（默认 3100）
- `ADMIN_KEY`：管理页密钥（管理页 `/admin?key=xxx`，可生成配对码/查用户）
- `CLOUD_DATA_ROOT`：数据目录（默认 `./data`）

### 第 2 步：配置 CLI 服务器地址（每台电脑）

```bash
node scripts/inv.mjs config --server http://你的服务器IP:3100
```

> 局域网内用电脑 IP（如 `http://192.168.1.100:3100`）；公网用域名或云服务器 IP。

### 第 3 步：注册账户 + 登录绑定（每台电脑）

```bash
# 第一台电脑：注册账户（一个店一个账户）
node scripts/inv.mjs register --username 店名 --password 你的密码

# 第一台电脑：登录绑定本机
node scripts/inv.mjs login --username 店名 --password 你的密码

# 第二台电脑：无需注册，直接同一账户登录 → 数据共享
node scripts/inv.mjs login --username 店名 --password 你的密码
```

---

## 二、CLI 命令全集

| 命令 | 说明 |
|------|------|
| `inv.mjs config --server <URL>` | 设置云服务器地址 |
| `inv.mjs config --show` | 查看当前配置 |
| `inv.mjs register --username <名> --password <密码>` | 注册账户 |
| `inv.mjs login --username <名> --password <密码>` | 登录并绑定本机为设备 |
| `inv.mjs status` | 查看云同步状态 |
| `inv.mjs sync` | 手动同步经营快照 |
| `inv.mjs backup` | 上传整库备份 |
| `inv.mjs backups` | 列出云端备份 |
| `inv.mjs restore --date <YYYY-MM-DD>` | 从云端备份恢复 |
| `inv.mjs devices` | 查看本账户已绑定设备 |
| `inv.mjs help` | 帮助 |

---

## 三、多设备机制说明

- **一个账户 = 一个店**：注册一次，所有电脑共用
- **每台电脑独立设备凭证**：登录后本机持有独立 uploadToken，互不影响
- **数据共享**：任一电脑上传的快照/备份，其他电脑立即可见
- **端到端加密**：数据用本机密钥 AES-256-GCM 加密后上传，服务器只见密文
- **远程看店**：绑定后自动生成 `/v/<token>#key=xxx` 链接，手机浏览器打开即看经营快照

## 四、桌面端 GUI 接入

设置 → 云备份 · 远程看店 → 「登录账户」标签：
1. 点「注册账户」创建账户（或直接在 CLI 注册过）
2. 输入账户名 + 密码，点「登录（绑定本机）」
3. 配对成功后即可用「立即同步」「云端备份」等

---

## 五、API 一览（供二次开发）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/account/register | 注册账户 {username, password, note} |
| POST | /api/account/login | 登录 {username, password} |
| POST | /api/device/bind | 绑定本机为设备（多设备入口） |
| POST | /api/snapshot | 上传经营快照（加密） |
| POST | /api/backup | 上传整库备份 |
| GET | /api/backup/list | 列出备份 |
| GET | /api/backup/download?date= | 下载备份 |
| GET | /v/{viewToken} | 远程看店页 |
| GET | /admin?key= | 管理页（生成配对码/用户列表） |