Let me extract the multi-site section, check the roadmap for POS plans, and confirm the mobile app's sales order workflow.

=== 分段 ===

Let me extract the multi-site section from the raw HTML and check the installer page for Windows support.

=== 分段 ===

Let me extract the multi-site section from the search index and search GitHub issues for POS-related discussion.

=== 分段 ===

Let me confirm report/label printing and the data import file formats, then compile the report.

=== 分段 ===

Let me quickly confirm the data export/import file formats, then I'll compile the report.

=== 分段 ===

调研完成。以下是基于官方文档（docs.inventree.org）、GitHub 仓库与搜索索引的结论报告。

---

# InvenTree 能力边界调研（v1.4.3，2026-07 发布，7.3k stars，维护极活跃）

1. **POS/收银 ❌**：无 POS 模块，只有销售订单(SO)。全文搜索 point of sale/checkout/payment/cart 均为 0 命中；GitHub 唯一 POS 类请求（#11143）已关闭。收银台所需扫码加购、多支付、打折、小票全无。
2. **赊账/应收 ❌**：客户=Company 模型，仅联系人/地址，无余额、收款、对账单。SO 无付款字段。
3. **移动端 ✅**：官方原生 App（iOS/Android，Play/App Store）+ 手机浏览器可访问网页版并内置扫码（摄像头/扫码枪/键盘）。能管库存、单据、扫码开单，但无收银流程。
4. **离线 ❌**：纯服务器模式，App 与网页必须连服务器，无本地离线。
5. **条码 ✅**：原生支持内部/外部/自定义条码，标签可嵌条码，API 可扫，插件可扩展。
6. **保质期批次 ✅**：批次/序列号（trackable 零件）、expiry 日期（默认关闭需开）、临期提醒(STOCK_STALE_DAYS)、自动分配支持 FEFO/FIFO/LIFO。
7. **REST API ✅**：DRF 完整 CRUD、自文档、token/basic/OAuth2 认证、权限对齐角色，足以支撑自建前端/手机端。
8. **插件 ✅**：PIP 安装 + Mixin 体系（Barcode/Report/Label/Event 等），可自定义字段、流程、UI 面板、标签模板。
9. **多员工/多店 ⚠️**：Role+Group 权限（View/Add/Change/Delete）完备；多店靠库存位置树（multi-location）；多站点只是 Django sites，无多租户账套隔离。
10. **部署 ⚠️**：官方不支持 Windows 原生（FAQ 明示"需 Docker"）；Linux 一键安装。默认 SQLite，支持 PostgreSQL/MySQL/MariaDB。升级=发版+迁移。
11. **数据迁移 ⚠️**：Admin Center 内置 CSV/Excel 逐模型导入（需先建关联数据，不支持多级导入）；有 SQLite→PostgreSQL 迁移文档；外部数据需整理模板。
12. **社区与插件 ❌(POS 插件)**：维护极活跃（push 至 2026-08-05）。第三方插件多为电子元件 BOM 导入工具（DigiKey/LCSC/Mouser/PartKeepr），无 POS/进销存零售插件。

---

**用它做通用进销存底座，必须自建清单（按优先级）**
1. **POS 收银台**：购物车、扫码加购、多支付、折扣、小票打印（可复用 label/report PDF 模板）。
2. **客户赊账**：余额、收款登记、欠款/对账报表（核心模型缺失，需新表）。
3. **零售化改造**：UI 偏生产制造（BOM/工单/序列号强），需简化流程与汉化。
4. **离线容灾**：本地缓存/断网可用（基于 REST API 自建）。
5. **多门店隔离**：多租户独立账套（现仅位置树+多 site）。
6. **数据导入向导**：封装 Excel 导入模板，先建分类/供应商再导入。

注：Windows 需 Docker；若客户机器无 Docker，部署成本会显著上升，需进一步验证本机 Docker 可行性。