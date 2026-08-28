# 进销存云同步服务器

零依赖 HTTP 服务（node:http），为通用进销存系统提供**多设备云同步 + 远程看店**。

## 快速启动

```bash
# 开发/临时（前台）
node index.js
# 或双击 start-cloud.bat

# 生产（pm2 后台常驻）
npm install -g pm2
pm2 start index.js --name inventory-cloud
pm2 save
# 或双击 install-service.bat
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| PORT | 3100 | 服务端口 |
| ADMIN_KEY | 无 | 管理页密钥（`/admin?key=xxx`） |
| CLOUD_DATA_ROOT | ./data | 用户数据目录 |

## 核心能力

- **多设备账户**：注册账户 → 每台电脑登录绑定（独立设备凭证，共享云端数据）
- **快照同步**：经营快照加密上传（/api/snapshot）
- **整库备份**：每日备份 + 30 份轮换（/api/backup）
- **远程看店**：/v/{viewToken}#key= 手机浏览器查看经营概览
- **端到端加密**：AES-256-GCM，服务器只见密文

## 管理页

浏览器打开 `http://localhost:3100/admin?key=你的ADMIN_KEY`：
- 生成一次性配对码（老式接入）
- 查看用户列表/设备/备份状态

## API 文档

见项目 docs/CLI接入指南.md 第五节。
