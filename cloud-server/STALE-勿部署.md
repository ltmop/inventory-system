# ⚠️ STALE · 此 cloud-server 副本已过期，禁止作部署源

- **状态**：只读 · 过期副本（快照时间 2026-08-30）
- **原因**：cloud-server 生产源已唯一化为 `D:\通用进销存` desktop-wip（含 8/30 后全部生产演进 + cockpit V2，index.js 28KB 为超集）。本目录为更早的 15.6KB 版本，缺 8/30 之后的云同步/会话/多租户改动。
- **规则**：任何人（含 Agent）**不得**以本目录文件部署 `/opt/inventory-cloud` 或覆盖线上；改动 cloud-server 一律到 `D:\通用进销存`（desktop-wip）操作，部署用 `git show <锚点>:cloud-server/index.js` 精确取版。
- **权威依据**：《进销存系统开放经验与教训》§8.1（知识库 70-进销存系统项目）。
