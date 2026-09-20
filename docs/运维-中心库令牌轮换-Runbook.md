# 运维 · 中心库 / 局域网令牌轮换 Runbook

> 本文回答两件事：**令牌都在哪儿、谁手里有一份**；以及**真要换的时候按什么顺序换**。
> 最后更新：2026-09-21（起因见文末「这次为什么要写这份文档」）。

---

## 0. 一句话结论

换令牌**本身是一条命令**，麻烦的从来不是换，而是**换完之后要把所有拿着旧令牌的地方一起换掉**——
漏一处就表现为「某个手机/某台电脑突然连不上了」，而且报错只有 `401`，很难猜。

所以本文最有用的部分不是「怎么换」，是第 2 节那张**清单**。

---

## 1. 系统里其实有四种令牌，别搞混

| 令牌 | 文件/位置 | 能干什么 | 谁需要它 |
|---|---|---|---|
| **本机局域网令牌**（写） | 桌面机 `%APPDATA%\fishing-inventory\server-token.txt` | 那台电脑 HTTP 服务的**全部读写**（开单、入库、改商品…） | 同一局域网里的手机/平板，`/m` 与 `/app` |
| **本机只读令牌** | 同目录 `server-view-token.txt` | 只能看报表/库存，写操作一律 `403` | 只读账号（财务/老板手机只看） |
| **中心库令牌**（写） | 服务器 `/opt/inventory-app/data/server-token.txt` | 中心库的**全部读写** | 店里每台桌面端、每台手机、CLI |
| **中心库只读令牌** | 服务器 `/opt/inventory-app/data/server-view-token.txt` | 中心库只读 | 同上（只读身份） |

三处事实（都是从代码里读出来的，不是推测）：

- 令牌格式固定 **32 位十六进制**（`crypto.randomBytes(16).toString('hex')`，`electron/server.js:821`）。
  文件内容不合法就**自动生成一个新的并写回**（`server.js:814-825`）。
- 鉴权是 `tokenOk()`：**写令牌和只读令牌都放行读**；写通道额外查 `isViewToken` → 只读身份写入返回 `403`
  （`server.js:877-880`、`server.js:1399-1402`）。
- 令牌从 `?token=` 或 `x-token` / `Authorization: Bearer` 头取（`server.js:962-970`）。

---

## 2. 🔴 换之前必须先数清的「持有人」清单

**中心库令牌**（`/opt/inventory-app/data/server-token.txt`）的副本散在这些地方：

| # | 位置 | 怎么更新 |
|---|---|---|
| 1 | 每台桌面机 `%APPDATA%\fishing-inventory\central.json` 的 `token` 字段 | 桌面端里**重新连接中心库**（重新配对/重新登录） |
| 2 | 每台桌面机渲染层的 `localStorage`：`fi-central-url` / `fi-central-token` | 同上（配对流程会一起写） |
| 3 | 每台手机 `/m` 的 `localStorage`：`fi-mobile-token`（可能还有 `fi-server`） | 手机上**重新输入连接码 / 重新扫码 / 重新登录** |
| 4 | 打印出来的二维码、手机书签（`/v/<token>` 手机看店链接） | 重新打印/重新发链接，旧的一律失效 |
| 5 | 命令行工具 `INV_TOKEN` 或 `--token`（`docs/进销存系统Agent接入指南.md`） | 换掉环境变量/参数 |
| 6 | 任何把中心库接出去的外部 Agent / 对接方 | 通知对方 |

**本机局域网令牌**（某台电脑的 `server-token.txt`）的副本：
同一局域网里的手机/平板（扫过那台机的二维码）、那台机自己的 `/v/` 书签、以及 `docs/进销存系统Agent接入指南.md` 里写的
`Windows: %APPDATA%\fishing-inventory\server-token.txt`。

> 换句话说：**中心库令牌轮换 = 一次全店重新配对**。要挑一个店里不忙的时间做。

---

## 3. 换法

### 3.1 换某台桌面机自己的局域网令牌（最简单，界面里点）

1. 那台电脑上打开软件 → **设置 → 手机看店** → 点「**重新生成访问密码**」。
2. 界面会二次确认：「重新生成访问密码后，之前保存的二维码和手机书签都会失效，需要用新二维码重新扫码。」
   （`src/pages/SettingsPage.tsx:211-217`，走 `server:regenerateToken`）
3. 确认后：旧二维码/旧书签全部失效；**把新二维码给店里的手机重新扫一次**。
4. 旧令牌会被覆盖写入 `server-token.txt`（0600 权限），**服务不用重启**（`regenerateToken()` 在内存里同步换了）。

### 3.2 换中心库令牌（在服务器上做，需要 SSH）

> 服务器上跑的是 pm2 的 `inventory-app`（`/opt/inventory-app`），不是桌面端；
> **桌面端那个「重新生成访问密码」按钮管不到中心库**。

```bash
# ① 先备份（红线：改服务器先备份再覆盖）
TS=$(date +%Y%m%d-%H%M%S)
sudo cp -a /opt/inventory-app/data/server-token.txt      /opt/inventory-app/data/server-token.txt.bak-$TS
sudo cp -a /opt/inventory-app/data/server-view-token.txt /opt/inventory-app/data/server-view-token.txt.bak-$TS

# ② 生成新令牌（32 位十六进制，权限 600）
NEW=$(openssl rand -hex 16)
echo "$NEW" | sudo tee /opt/inventory-app/data/server-token.txt >/dev/null
sudo chmod 600 /opt/inventory-app/data/server-token.txt
# 只读令牌要换的话同理写 server-view-token.txt

# ③ 重启让新令牌生效
pm2 restart inventory-app

# ④ 自查：不带令牌必须 401；带新令牌取一张图/一条接口应通
curl -s -o /dev/null -w '%{http_code}\n' 'https://app.junchengzn.com/api/summary'                 # 期望 401
curl -s -o /dev/null -w '%{http_code}\n' "https://app.junchengzn.com/api/summary?token=$NEW"       # 期望 200
```

**回滚**（换错了/有人还没配对完要退回）：

```bash
sudo cp -a /opt/inventory-app/data/server-token.txt.bak-<TS> /opt/inventory-app/data/server-token.txt
pm2 restart inventory-app
```

### 3.3 换完之后（这份清单别跳步）

- [ ] 每台桌面机：设置里**重新连接中心库**（确认界面不再报 401、数据能刷出来）
- [ ] 每台手机：重新扫码 / 重新输连接码，随便开一单或查一次库存
- [ ] 桌面机自己那台的局域网令牌若也换了 → 重新给手机扫二维码
- [ ] CLI / 外部对接方换 `INV_TOKEN`
- [ ] 旧二维码作废（该撕的撕掉，别留在柜台上）
- [ ] **确认备份文件还在**，直到全店都确认通了再删

---

## 4. 这次为什么要写这份文档

2026-09-21 修「中心库模式下桌面端看不到商品图」时，排查的第一步是读
`%APPDATA%\fishing-inventory\central.json`——我把**文件原文（含 `token` 明文）打印进了会话记录**，
违反了「生产密钥零明文」这条红线。

- 暴露范围：**这台电脑的本地会话记录**，未发往外部服务、未提交进 git。
- 但既然明文出现过一次，就按「已暴露」对待：把散落位置和轮换步骤写清楚，
  由 owner 决定**换**（成本 = 全店重新配对，见第 2 节）还是**不换**（成本 = 接受这次暴露）。
- 后续所有检查已改成只回**布尔值 / HTTP 状态码 / 哈希**，不再打印令牌本身。

> 本文件不含任何真实令牌值。**任何 Runbook 都不该写真实密钥。**
