# 语音库存录入 MVP 方案

> 阿杜 | 2026-08-11 | 基于现有进销存系统（inventory-general v2.3.0）能力复用
> 目的：实现"按住说话 → 语音转文字 → AI 提取商品信息 → 用户确认 → 写入库存库"，服务"个体户对话即录入"产品卖点

---

## 一、现状盘点（复用，不重造）

系统已有以下可复用的积木：

| 能力 | 位置 | 现状 |
|------|------|------|
| **本地离线语音识别**（中文） | `electron/voice.js` | sherpa-onnx + paraformer-zh-small int8，模型加载 ~1.1s，单次转写 <150ms；`transcribePcm()` 已可用 |
| **唤醒词** | `electron/kws.js` + `src/lib/wakeWord.ts` | 已有唤醒词引擎 |
| **TTS** | `electron/tts.js` + `src/lib/tts.ts` | 语音回复可用 |
| **AI 对话**（Kimi/Moonshot） | `electron/ai.js` | `chatRaw()` 封装；`chat()` 通用对话；已有 `parseInboundNote()`（图片进货单→JSON）作范式参考 |
| **AI 面板** | `src/components/ai/AiPanel.tsx` | 已有 AI 交互 UI |
| **语音搜索按钮** | `src/components/voice/VoiceSearchButton.tsx` | 已有语音入口组件 |
| **MCP/本地服务** | `electron/server.js`（1300行） | 已有本地服务/接口层 |
| **数据库** | `electron/db.js` | 18 张表，`products`/`inventory_batches` 表结构稳定 |

**结论**：语音录入 MVP = **把 `parseInboundNote`（图片输入）的模式，平移到"语音文本输入"**，加上确认层。

---

## 二、MVP 目标

一句话：**按住说话描述进货/入库 → AI 提取结构化商品 → 用户确认 → 写入 products + inventory_batches**。

范围（MVP 不做）：
- ❌ 越南语语音识别（本地模型是中文，越南语后置）
- ❌ 自动对账 / 预测补货
- ❌ 多用户 / 云同步
- ❌ 硬件机器人

---

## 三、用户流程

```
用户：按住说话 → "进了碳素竿3米6，10根，每根350块，厂家是XX"
  ↓
系统：本地 ASR → 文本
  ↓
系统：AI 提取 → 卡片展示：
  ┌─────────────────────────────┐
  │ 商品：碳素竿 3.6m             │
  │ 数量：10 根                  │
  │ 单价：350 元                 │
  │ 供应商：XX（可下拉）           │
  │ [确认入库]  [修改]  [取消]     │
  └─────────────────────────────┘
  ↓（用户点"确认入库"）
系统：写 inventory_batches（+ 若新商品先写 products）
  ↓
系统：TTS 回复"已入库 10 根碳素竿"
```

---

## 四、技术架构

```
┌────────────────────────────────────────────┐
│ 渲染端 (React)                               │
│  VoiceSearchButton / 新 VoiceInbound 组件     │
│  → 录音 → OfflineAudioContext 重采样 16k      │
└──────────────────┬─────────────────────────┘
                   │ IPC (voice:transcribe)
┌──────────────────▼─────────────────────────┐
│ 主进程 (electron/voice.js)                   │
│  sherpa-onnx 本地 ASR → 文本                 │
└──────────────────┬─────────────────────────┘
                   │ 文本
┌──────────────────▼─────────────────────────┐
│  AI 提取 (electron/ai.js 新增 extractInboundText)│
│  输入：语音文本 + 店内商品清单                  │
│  输出：{"items":[{brand,model,category,       │
│        quantity,cost_price_yuan,product_id}]}│
└──────────────────┬─────────────────────────┘
                   │ JSON（未写库，等待确认）
┌──────────────────▼─────────────────────────┐
│ 确认层（前端组件 ConfirmCard）                 │
│  用户确认/修改 → 才调入库接口                  │
└──────────────────┬─────────────────────────┘
                   │ 确认后
┌──────────────────▼─────────────────────────┐
│ 写库 (electron/db.js)                        │
│  → 新商品写 products                          │
│  → 批次写 inventory_batches                   │
└────────────────────────────────────────────┘
```

---

## 五、数据库对接

### products 表（新商品时写入）
```sql
INSERT INTO products (sku_code, category, brand, model, cost_price, suggest_price, unit, status, name_vi)
VALUES (?, '渔具', ?, ?, ?, ?, '件', '待盘点', NULL)
```
- sku_code 生成规则：`{brand}-{model}-{yyyyMMdd}{seq}` 或走现有规则
- unit 默认 `件`；钓线/线材类建议 `米`（v2.2 计量单位）

### inventory_batches 表（入库批次）
```sql
INSERT INTO inventory_batches (product_id, supplier_id, batch_no, quantity, cost_price, location, inbound_date, notes, expiry_date)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
```
- batch_no 生成：`IN{yyyyMMdd}-{seq}`
- supplier_id：匹配到现有供应商则填，否则空（MVP 允许空，后续补）

---

## 六、AI 提取提示词（新函数 `extractInboundText`）

在 `electron/ai.js` 新增，**参照 `parseInboundNote` 的成熟模式**（商品清单喂模型 + 严格 JSON + 剥代码块）：

```javascript
export async function extractInboundText({ text } = {}) {
  if (!db) return { ok: false, reason: 'db-not-ready' }
  if (!text || typeof text !== 'string') return { ok: false, reason: 'no-text' }

  const products = db
    .prepare('SELECT id, brand, model, category, sub_category, cost_price FROM products LIMIT 200')
    .all()
  const productList = products
    .map((p) => `${p.id}|${p.brand ?? ''}|${p.model ?? ''}|${p.category}${p.sub_category ? '/' + p.sub_category : ''}|进价${p.cost_price}元`)
    .join('\n')

  const r = await chatRaw([
    {
      role: 'system',
      content: '你是门店的入库录单员。用户会口述一批进货/入库商品，你要把口述内容提取成结构化数据。只输出 JSON，不要 markdown 代码块，不要任何解释文字。',
    },
    {
      role: 'user',
      content:
        '从这段口述中提取入库商品，输出格式：\n' +
        '{"items":[{"brand":"品牌","model":"型号","category":"品类","quantity":数量,"cost_price_yuan":单价数字,"product_id":匹配ID或null,"supplier_name":"供应商或null"}]}\n' +
        '规则：\n' +
        '1. 能与店内商品清单匹配的行填 product_id（清单第一列），匹配不上填 null\n' +
        '2. category 用通用分类：食品饮料/日用百货/五金工具/电子电器/服饰鞋帽/文具办公/清洁日化/其他 之一\n' +
        '3. 数量是数字（根/个/包→件数），看不清的字段填 null\n' +
        '4. 只输出 JSON\n\n' +
        `口述内容：${text}\n\n` +
        `店内商品清单（ID|品牌|型号|品类|最近进价）：\n${productList || '（店内暂无商品）'}`,
    },
  ], { maxTokens: 1200 })
  if (!r.ok) return r

  // 剥 ```json 包裹后 JSON.parse（与 parseInboundNote 一致）
  const jsonText = (r.message.content ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return { ok: true, items: JSON.parse(jsonText).items ?? [] }
  } catch {
    return { ok: false, reason: 'AI 返回格式异常，请重试' }
  }
}
```

> **防幻觉设计**：模型只负责"提取 + 匹配候选"，**不直接写库**。数量/单价/供应商全部经用户确认层校验后才入库。规格（3米6/号数）有歧义时，模型填 null，让用户补。

---

## 七、确认层设计（Human-in-the-loop）

**为什么必须**：LLM 提取口述信息时，数量、规格、越南语名称的幻觉风险高。一个确认按钮把错误率从 ~15% 降到 ~1%。

- 前端组件：`src/components/voice/VoiceInboundConfirm.tsx`（新增，参照 AiPanel/Receipt 风格）
- 展示：每行 = 品牌/型号/数量/单价/供应商 + 可编辑输入框
- 操作：`[确认入库]`（逐行或全部）/ `[修改]` / `[取消]`
- 确认后调主进程 `inbound:commit`（IPC）→ db.js 事务写入 products + inventory_batches

---

## 八、ASR 说明

| 场景 | 方案 | 状态 |
|------|------|------|
| 中文口述（店主/店员） | **现有 sherpa-onnx 本地识别** | ✅ 现成，零成本 |
| 语音不准/环境嘈杂 | 降级：手动打字输入（Fallback） | ✅ 现有输入框 |
| 越南语语音 | 后置：需换 sherpa-onnx 越南语模型或云端 ASR | ⏸️ MVP 不做 |

---

## 九、实现步骤（分阶段，每步可验收）

### Step 1：后端提取接口（半天）
- `electron/ai.js` 新增 `extractInboundText()`（上文代码）
- 单元测试 `src/lib/...test.ts`（参照现有 ai 测试风格）
- 验收：命令行 / IPC 直接调，输入口述文本 → 返回结构化 items

### Step 2：前端语音入口 + 确认卡片（1天）
- 复用 `VoiceSearchButton` 的录音逻辑 → 拿 ASR 文本
- 新增 `VoiceInboundConfirm` 组件（确认卡片）
- 接入 AiPanel 或开单页入口
- 验收：按住说话 → 文字 → AI 提取 → 卡片展示

### Step 3：写库提交（半天）
- 主进程 `inbound:commit` IPC → db.js 事务（products + inventory_batches）
- 生成 sku_code / batch_no
- TTS 成功播报
- 验收：确认后数据库新增批次，库存数量正确

### Step 4：联调 + 真实测试（1天）
- 用真实口述测 5 种场景：新商品 / 已有商品 / 含供应商 / 多商品一单 / 模糊信息
- 确认层人工纠错流程验证
- 验收：5 场景全部正确入库，无脏数据

---

## 十、风险与边界

| 风险 | 等级 | 应对 |
|------|------|------|
| ASR 中文识别不准（专有名词"碳素竿/PE线"） | 🟡 | 确认层兜底；可后续加领域词库 |
| AI 提取规格幻觉（3米6 vs 3.6米） | 🟡 | 模型填 null + 用户确认层强制校验 |
| 同型号不同规格（碳素竿 3m/3.6m/4.5m） | 🟡 | 商品清单含 model 全名喂给模型，匹配不上就让用户选 |
| 写库后才发现错了 | 🟢 | 走现有报损/退货流程（已有 waste_logs） |

---

## 十一、验收标准（MVP 完成定义）

- [ ] 按住说话 → 中文口述 → 本地 ASR 转写成功（无网络）
- [ ] AI 提取结构化 items（匹配店内商品清单）
- [ ] 确认卡片可编辑 + 确认/取消
- [ ] 确认后 products + inventory_batches 正确写入
- [ ] 5 种测试场景全部通过
- [ ] TTS 语音播报反馈

---

## 十二、与 Phase 2 产品的关系

语音录入是 Phase 2（进销存 v1.15 手机端）的**核心卖点"开单那一刻的痛快"**的一部分：
- 手机端语音开单 → 进销存数据
- 采集的数据同时进入 A1/A3 知识库（供应链知识沉淀）
- 为后续"自动补货建议 / AI 定价"提供数据燃料

---

*方案版本：v1.0 | 待 Claude Code 按 Step 1-4 实施*
