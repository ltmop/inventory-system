// 局域网 HTTP 服务：老板手机连店里同一个 WiFi，微信扫码看账 + 开单卖货
// 零依赖（Node 内置 http），不 import electron，db/dataDir 注入，可被 scripts/test-backend.mjs 直接单测
// 安全基线：随机 token 鉴权（401）+ 路径白名单（404）+ 方法白名单（GET，POST 仅 /api/outbound，其余 405）
//           + 每 IP 120 次/分钟速率限制（429）+ 安全响应头
// 写接口（POST /api/outbound）加严：独立限流每 IP 30 次/分钟、Content-Type 必须 application/json、
//           请求体限 8KB、字段白名单严格校验，业务校验与桌面端共用 commands.confirmOutbound
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { listCommands, describeCommand } from './commandApi.js'
import { ensureTlsCert } from './tls.js'

// ESM 无 __dirname，这里补一个（serveMobile 托管 electron/mobile/ 用）
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 口径层的**唯一入口**（P2 2026-09-15）：commandsLive 会先尝试热更的口径层，失败静默回内置。
// 这里只是把同一份命名空间摊开成原来的名字，**不改任何调用点**；但绝不许再直接 import './commands.js'
// —— 那样会出现"一半走热更、一半走内置"的口径分叉（同一件事桌面端和服务端算出不同结果）。
import { commands as cmds, search, analytics } from './commandsLive.js'
const { confirmOutbound, listCustomers, lowStockProducts, auditLog, supplierStatement, todayPaymentSplit } = cmds
// 中心库模式下必须由**服务端**跑的通道（2026-09-14 补，见 docs/中心库模式-通道缺口清单.md）：
//   · 商品模糊搜索的本地兜底口径 → 与桌面端 ai-orchestrator 共用同一份 search（红线①：口径只走命令层）
//   · 知识库读写 → db.js 的助手（与桌面端同一份实现）
const { productNamesForSearch, localSearchHit } = search
import { saveInsight, listInsights, updateInsight, deleteInsight } from './db.js'
const { analyticsTrend, analyticsCategory, analyticsTop, analyticsStockValue, analyticsOverview } = analytics
import { createPhotoStore } from './photo.js'

const DEFAULT_PORT = 17532
const MAX_PORT_RETRY = 10
const RATE_LIMIT_PER_MIN = 120
// 任务7（审计 2026-08-30）：带合法 token 的请求按 token 维度放宽限流——
// 店内多台设备同出口（NAT 同 IP）高频操作不再被 120/min 误伤；无 token 仍按 IP 限流防爆破
const TOKEN_RATE_LIMIT_PER_MIN = 600
// 写接口独立限流（更严）与请求体上限
const WRITE_RATE_LIMIT_PER_MIN = 30
// 任务7+：带合法 token 的写请求按 token 维度放宽（多设备同出口高峰开单不误伤）
const TOKEN_WRITE_RATE_LIMIT_PER_MIN = 60
const MAX_BODY_BYTES = 8192
// 通用调用接口（/api/invoke）请求体上限：批量导入/商品图片 base64 会到几百 KB
const MAX_INVOKE_BODY = 2 * 1024 * 1024

// 跨域（默认关闭 = 与历史行为完全一致）。手机 APP 跑在 http://localhost、接口打中心库属跨域；
// 反代层（Caddy）若没补 CORS，浏览器预检失败会让 APP 全部请求被拦。
// 但反代若已经加了 CORS，这里再加一次会输出重复的 ACAO，浏览器反而直接判定失败 ——
// 所以做成显式开关，只在实测确认反代没补时才打开：
//   FI_CORS_ALLOW_ORIGINS=http://localhost,https://app.junchengzn.com
const CORS_ORIGINS = String(process.env.FI_CORS_ALLOW_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean)

// 桌面网页版（/app）静态资源 MIME
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
// /app 的 CSP 比手机页放宽：要加载自己的 js/css 文件，图片允许 data/blob（拍照预览）
const APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:"

// ---------- 统计查询（口径参照 DashboardPage：金额单位分，退货冲减营业额/毛利） ----------

/** 本地今日 00:00 ~ 明日 00:00 的 UTC ISO 区间（transactions.timestamp 存 UTC ISO） */
function todayRange() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}

function querySummary(db) {
  const [from, to] = todayRange()
  const txs = db
    .prepare(
      `SELECT type, quantity, unit_price, selling_price, notes FROM transactions
       WHERE timestamp >= ? AND timestamp < ?`,
    )
    .all(from, to)
  let todayRevenue = 0
  let todayProfit = 0
  let todayInQty = 0
  let todayOutQty = 0
  for (const t of txs) {
    if (t.type === 'in') {
      todayInQty += t.quantity
    } else if (t.type === 'out') {
      todayOutQty += t.quantity
      // 换货出新腿也是正常 out，与桌面端同口径自动涵盖
      if (t.selling_price != null) todayRevenue += t.selling_price * t.quantity
      if (t.selling_price != null && t.unit_price != null) {
        todayProfit += (t.selling_price - t.unit_price) * t.quantity
      }
    } else if (t.type === 'return' && t.notes !== '换货退旧') {
      // 退货按负收入冲减营业额和毛利（换货退旧腿不冲减，与桌面端一致）
      if (t.selling_price != null) todayRevenue -= t.selling_price * t.quantity
      if (t.selling_price != null && t.unit_price != null) {
        todayProfit -= (t.selling_price - t.unit_price) * t.quantity
      }
    }
  }
  const totalSku = db.prepare('SELECT COUNT(*) AS n FROM products').get().n
  const stock = db
    .prepare('SELECT COALESCE(SUM(quantity),0) AS q, COALESCE(SUM(quantity * cost_price),0) AS v FROM inventory_batches')
    .get()
  // 低库存口径与桌面端统一：COALESCE(min_stock, 默认阈值)，见 commands.lowStockProducts
  const lowStockCount = lowStockProducts(db).length
  return {
    todayRevenue,
    todayProfit,
    todayInQty,
    todayOutQty,
    totalSku,
    totalStock: stock.q,
    stockValue: stock.v,
    lowStockCount,
    payments: todayPaymentSplit(db),
  }
}

/** 低库存商品列表（总库存 < 各自预警线 min_stock ?? 默认，升序，最缺的在前） */
function queryLowStock(db) {
  return lowStockProducts(db).map((r) => ({
    name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code,
    sku: r.sku_code,
    stock: r.stock,
    threshold: r.threshold,
    location: r.location,
  }))
}

/** 库存搜索：关键词匹配品牌/型号/SKU/条码（LIKE 通配符转义），老板在仓库找货/手机开单用 */
function queryInventory(db, q) {
  const keyword = String(q ?? '').trim()
  if (!keyword) return []
  const like = `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const tierStmt = db.prepare('SELECT tier, price FROM price_tiers WHERE product_id = ?')
  return db
    .prepare(
      `SELECT p.id, p.brand, p.model, p.sku_code, p.barcode, p.location, p.cost_price, p.suggest_price,
              p.rod_length, p.rod_action, p.power_rating, p.line_number,
              p.hook_size, p.color, p.material, p.expiry_date, p.photo_path,
              COALESCE(s.q, 0) AS stock
       FROM products p
       LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_batches GROUP BY product_id) s
         ON s.product_id = p.id
       WHERE p.brand LIKE ? ESCAPE '\\' OR p.model LIKE ? ESCAPE '\\'
          OR p.sku_code LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\'
       ORDER BY p.id ASC
       LIMIT 50`,
    )
    .all(like, like, like, like)
    .map((r) => ({
      id: r.id,
      name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code,
      sku: r.sku_code,
      barcode: r.barcode ?? null,
      stock: r.stock,
      costPrice: r.cost_price,
      suggestPrice: r.suggest_price ?? null,
      // 各档价格（retail/regular/VIP/wholesale/promo → 分），开单页按客户价格档自动带价
      priceTiers: Object.fromEntries(tierStmt.all(r.id).map((t) => [t.tier, t.price])),
      // 商品规格（只带有值的字段）：颜色/材质/保质期
      specs: Object.fromEntries(
        [
          ['rod_length', r.rod_length],
          ['rod_action', r.rod_action],
          ['power_rating', r.power_rating],
          ['line_number', r.line_number],
          ['hook_size', r.hook_size],
          ['color', r.color],
          ['material', r.material],
          ['expiry_date', r.expiry_date],
        ].filter(([, v]) => v != null && v !== ''),
      ),
      location: r.location,
      // 商品图片相对文件名（images 目录内），手机页经 /api/photo?path= 取图；没图为 null
      photoPath: r.photo_path ?? null,
    }))
}

/** 客户列表（手机开单选客户用）：id/姓名/当前欠款/价格档；口径与桌面端 listCustomers 一致 */
function queryCustomers(db) {
  return listCustomers(db).map((c) => ({
    id: c.id,
    name: c.name,
    outstanding: c.outstanding,
    priceLevel: c.price_level ?? null,
  }))
}

/** 今日出入库流水（最近 50 条，金额：出库/退货记售价、入库记成本价，单位分） */
function queryToday(db) {
  const [from, to] = todayRange()
  return db
    .prepare(
      `SELECT t.type, t.quantity, t.unit_price, t.selling_price, t.timestamp, t.notes,
              p.brand, p.model, p.sku_code
       FROM transactions t
       LEFT JOIN products p ON p.id = t.product_id
       WHERE t.timestamp >= ? AND t.timestamp < ?
       ORDER BY t.timestamp DESC, t.id DESC
       LIMIT 50`,
    )
    .all(from, to)
    .map((r) => ({
      time: r.timestamp,
      type: r.type,
      name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code || '',
      sku: r.sku_code ?? '',
      quantity: r.quantity,
      amount:
        r.type === 'in'
          ? r.unit_price != null
            ? r.unit_price * r.quantity
            : null
          : r.selling_price != null
            ? r.selling_price * r.quantity
            : null,
    }))
}

// ---------- 手机端页面（单文件 HTML，fetch 自动带 URL 里的 token） ----------

const MOBILE_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#1e3a5f">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>进销存 · 手机看店</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f0f4f9; color: #1f2937; padding-bottom: 32px; }
  header { background: linear-gradient(135deg, #1e3a5f, #1d4ed8); color: #fff; padding: 20px 16px 40px; }
  header h1 { font-size: 20px; font-weight: 700; }
  header .sub { font-size: 12px; opacity: .75; margin-top: 4px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 0 16px; margin-top: -24px; }
  .card { background: #fff; border-radius: 14px; padding: 16px; box-shadow: 0 2px 8px rgba(30,58,95,.08); }
  .card .label { font-size: 13px; color: #64748b; }
  .card .value { font-size: 26px; font-weight: 700; margin-top: 6px; font-variant-numeric: tabular-nums; color: #1e3a5f; }
  .card .value.green { color: #15803d; }
  .section { margin: 20px 16px 0; }
  .section h2 { font-size: 16px; font-weight: 700; margin-bottom: 10px; color: #1e3a5f; }
  .row { background: #fff; border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(30,58,95,.06); }
  .row .name { font-size: 15px; font-weight: 600; }
  .row .meta { font-size: 12px; color: #94a3b8; margin-top: 2px; font-family: monospace; }
  .row .num { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .num.red { color: #dc2626; }
  .num.blue { color: #1d4ed8; }
  .badge { display: inline-block; font-size: 11px; border-radius: 4px; padding: 1px 6px; margin-right: 6px; }
  .badge.out { background: #fee2e2; color: #dc2626; }
  .badge.in { background: #dcfce7; color: #15803d; }
  .badge.return { background: #fef3c7; color: #b45309; }
  .search { width: 100%; font-size: 16px; padding: 12px 14px; border: 2px solid #1d4ed8; border-radius: 12px; outline: none; margin-bottom: 10px; }
  .empty { text-align: center; color: #94a3b8; font-size: 13px; padding: 18px 0; }
  .err { margin: 20px 16px; background: #fee2e2; color: #b91c1c; border-radius: 10px; padding: 14px; font-size: 14px; }
  .time { font-size: 12px; color: #94a3b8; }
  .tabs { display: flex; gap: 10px; padding: 14px 16px 0; }
  .tab { flex: 1; font-size: 19px; font-weight: 700; padding: 13px 0; border: none; border-radius: 12px; background: #cbd5e1; color: #334155; }
  .tab.active { background: #1d4ed8; color: #fff; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 15px; font-weight: 600; margin-bottom: 6px; color: #1e3a5f; }
  .field input, .field select { width: 100%; font-size: 20px; padding: 12px; border: 2px solid #94a3b8; border-radius: 10px; outline: none; background: #fff; }
  .qty { display: flex; align-items: center; gap: 18px; }
  .qty button { width: 58px; height: 58px; font-size: 30px; line-height: 1; border: none; border-radius: 12px; background: #1d4ed8; color: #fff; }
  .qty span { font-size: 30px; font-weight: 800; min-width: 52px; text-align: center; font-variant-numeric: tabular-nums; }
  .pay-btns { display: flex; gap: 10px; }
  .pay { flex: 1; font-size: 18px; font-weight: 700; padding: 13px 0; border-radius: 10px; border: 2px solid #1d4ed8; background: #fff; color: #1d4ed8; }
  .pay.active { background: #1d4ed8; color: #fff; }
  .sell-prod { background: #fff; border-radius: 12px; padding: 14px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(30,58,95,.06); display: flex; align-items: center; }
  .sell-prod .name { font-size: 18px; font-weight: 700; }
  .sell-prod .meta { font-size: 13px; color: #94a3b8; margin-top: 4px; font-family: monospace; }
  .big-submit { width: 100%; font-size: 22px; font-weight: 800; padding: 17px 0; border: none; border-radius: 14px; background: #15803d; color: #fff; }
  .big-submit:disabled { background: #94a3b8; }
  .done { margin: 20px 16px 0; background: #dcfce7; color: #15803d; border-radius: 14px; padding: 24px 16px; font-size: 26px; font-weight: 800; text-align: center; line-height: 1.5; }
  .pickable { cursor: pointer; }
</style>
</head>
<body>
<header>
  <h1>进销存 · 手机看店</h1>
  <div class="sub" id="updated">数据加载中…</div>
</header>

<div class="tabs">
  <button class="tab active" id="tab-btn-home">看店</button>
  <button class="tab" id="tab-btn-sell">卖货</button>
</div>

<div id="page-home">
<div class="cards">
  <div class="card"><div class="label">今日营业额</div><div class="value" id="v-revenue">-</div></div>
  <div class="card"><div class="label">今日毛利</div><div class="value green" id="v-profit">-</div></div>
  <div class="card"><div class="label">今日入库</div><div class="value" id="v-in">-</div></div>
  <div class="card"><div class="label">今日出库</div><div class="value" id="v-out">-</div></div>
</div>
<div class="meta" id="v-paysplit" style="margin:4px 2px 10px"></div>

<div class="section">
  <h2>低库存预警</h2>
  <div id="lowstock"><div class="empty">加载中…</div></div>
</div>

<div class="section">
  <h2>查库存（输入品牌/型号/SKU/条码）</h2>
  <input class="search" id="q" type="search" placeholder="比如：光威、赤刃、JC-FG" autocomplete="off">
  <div id="result"></div>
</div>

<div class="section">
  <h2>今日流水</h2>
  <div id="today"><div class="empty">加载中…</div></div>
</div>
</div>

<div id="page-sell" style="display:none">
<div class="section">
  <h2>1. 找商品</h2>
  <input class="search" id="sell-q" type="search" placeholder="输入品牌/型号/SKU/条码" autocomplete="off">
  <div id="sell-result"></div>
</div>

<div class="section" id="sell-form" style="display:none">
  <h2>2. 开单</h2>
  <div class="sell-prod" id="sell-prod">
    <div>
      <div class="name" id="sell-name"></div>
      <div class="meta" id="sell-meta"></div>
    </div>
  </div>
  <div class="field">
    <label>数量</label>
    <div class="qty">
      <button id="q-minus" type="button">−</button>
      <span id="q-num">1</span>
      <button id="q-plus" type="button">＋</button>
    </div>
  </div>
  <div class="field">
    <label>单价（元，自动带价可改）</label>
    <input id="sell-price" inputmode="decimal" autocomplete="off">
  </div>
  <div class="field">
    <label>收款方式</label>
    <div class="pay-btns">
      <button class="pay active" id="pay-full" type="button">全额收款</button>
      <button class="pay" id="pay-credit" type="button">欠款记账</button>
    </div>
  </div>
  <div class="field">
    <label>到账方式</label>
    <select id="sell-method">
      <option value="现金" selected>现金</option>
      <option value="微信">微信</option>
      <option value="支付宝">支付宝</option>
      <option value="其他">其他</option>
    </select>
  </div>
  <div id="credit-box" style="display:none">
    <div class="field">
      <label>客户（欠款必须选人）</label>
      <select id="sell-cust"></select>
    </div>
    <div class="field">
      <label>本次实收（元，0 = 全欠）</label>
      <input id="sell-paid" inputmode="decimal" value="0" autocomplete="off">
    </div>
  </div>
  <button class="big-submit" id="sell-submit" type="button">确认卖出</button>
</div>
<div id="sell-done"></div>
</div>

<script>
var pageParams = new URLSearchParams(location.search);
var token = pageParams.get('token') || '';
// 扫码直达开单：商品贴纸二维码带 &barcode= 参数，打开页面自动锁定该商品进入开单
var deepBarcode = (pageParams.get('barcode') || '').trim();
function api(path) {
  var sep = path.indexOf('?') >= 0 ? '&' : '?';
  return fetch(path + sep + 'token=' + encodeURIComponent(token)).then(function (r) {
    if (r.status === 401) throw new Error('访问密码不对，请用店里电脑上最新的二维码重新扫码打开');
    if (!r.ok) throw new Error('加载失败（' + r.status + '），请确认手机连着店里的 WiFi');
    return r.json();
  });
}
function yuan(fen) { return fen == null ? '-' : '¥' + (fen / 100).toFixed(2); }
function esc(s) { return String(s == null ? '' : s); }
function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstChild; }

function addRow(box, name, meta, numHtml) {
  var row = document.createElement('div');
  row.className = 'row';
  var left = document.createElement('div');
  var n = document.createElement('div'); n.className = 'name'; n.textContent = name;
  var m = document.createElement('div'); m.className = 'meta'; m.textContent = meta || '';
  left.appendChild(n); left.appendChild(m);
  var right = document.createElement('div'); right.className = 'num'; right.innerHTML = numHtml;
  row.appendChild(left); row.appendChild(right);
  box.appendChild(row);
  return row;
}

// 商品缩略图：经 /api/photo 取图（带 token）；文件不在就隐藏 img，行照常用
function photoImg(photoPath, size) {
  var img = document.createElement('img');
  img.src = '/api/photo?path=' + encodeURIComponent(photoPath) + '&token=' + encodeURIComponent(token);
  img.alt = '';
  img.style.cssText = 'width:' + size + 'px;height:' + size + 'px;object-fit:cover;border-radius:8px;margin-right:10px;flex:none;background:#e2e8f0';
  img.onerror = function () { img.style.display = 'none'; };
  return img;
}

function loadSummary() {
  api('/api/summary').then(function (s) {
    document.getElementById('v-revenue').textContent = yuan(s.todayRevenue);
    document.getElementById('v-profit').textContent = yuan(s.todayProfit);
    document.getElementById('v-in').textContent = '+' + s.todayInQty;
    document.getElementById('v-out').textContent = '-' + s.todayOutQty;
    // 收款方式拆分：现金/微信/支付宝/其他 + 未记录 + 今日新增赊账（日结对账一眼对上）
    if (s.payments) {
      var parts = [];
      ['现金', '微信', '支付宝', '其他'].forEach(function (m) {
        if (s.payments.byMethod[m]) parts.push(m + ' ' + yuan(s.payments.byMethod[m]));
      });
      if (s.payments.unrecorded) parts.push('未记录 ' + yuan(s.payments.unrecorded));
      if (s.payments.credit) parts.push('新增赊账 ' + yuan(s.payments.credit));
      document.getElementById('v-paysplit').textContent = parts.length ? '今日到账：' + parts.join(' · ') : '';
    }
    document.getElementById('updated').textContent =
      '库存 ' + s.totalStock + ' 件 · 库存总值 ' + yuan(s.stockValue) + ' · 更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }).catch(showErr);
}
function loadLowStock() {
  api('/api/low-stock').then(function (items) {
    var box = document.getElementById('lowstock');
    box.innerHTML = '';
    if (!items.length) { box.innerHTML = '<div class="empty">库存都充足，没有预警</div>'; return; }
    items.forEach(function (it) {
      addRow(box, it.name, it.sku + (it.location ? ' · ' + it.location : ''),
        '<span class="red">剩 ' + it.stock + '</span>');
    });
  }).catch(showErr);
}
var TYPE_LABEL = { in: '入库', out: '出库', return: '退货', exchange: '换货' };
function loadToday() {
  api('/api/today').then(function (items) {
    var box = document.getElementById('today');
    box.innerHTML = '';
    if (!items.length) { box.innerHTML = '<div class="empty">今天还没有出入库记录</div>'; return; }
    items.slice(0, 20).forEach(function (t) {
      var d = new Date(t.time);
      var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      var cls = t.type === 'out' ? 'out' : t.type === 'in' ? 'in' : 'return';
      var sign = t.type === 'in' ? '+' : t.type === 'return' ? '−' : '−';
      addRow(box, t.name, hm + ' · ' + t.sku,
        '<span class="badge ' + cls + '">' + (TYPE_LABEL[t.type] || t.type) + '</span>' +
        '<span class="' + (t.type === 'in' ? 'blue' : '') + '">' + sign + t.quantity + '</span>' +
        (t.amount != null ? '<div class="time">' + yuan(t.amount) + '</div>' : ''));
    });
  }).catch(showErr);
}
var searchTimer = null;
document.getElementById('q').addEventListener('input', function (e) {
  clearTimeout(searchTimer);
  var q = e.target.value.trim();
  if (!q) { document.getElementById('result').innerHTML = ''; return; }
  searchTimer = setTimeout(function () {
    api('/api/inventory?q=' + encodeURIComponent(q)).then(function (items) {
      var box = document.getElementById('result');
      box.innerHTML = '';
      if (!items.length) { box.innerHTML = '<div class="empty">没搜到，换个关键词试试</div>'; return; }
      items.forEach(function (it) {
        var row = addRow(box, it.name, it.sku + ' · ' + yuan(it.costPrice),
          '<span class="' + (it.stock < 5 ? 'red' : 'blue') + '">' + it.stock + ' 件</span>' +
          (it.location ? '<div class="time">' + esc(it.location) + '</div>' : ''));
        if (it.photoPath) row.insertBefore(photoImg(it.photoPath, 48), row.firstChild);
      });
    }).catch(showErr);
  }, 300);
});
function showErr(e) {
  var old = document.querySelector('.err');
  if (old) old.remove();
  var d = document.createElement('div');
  d.className = 'err';
  d.textContent = e.message;
  document.body.appendChild(d);
}

// ---------- 卖货页签 ----------
function showTab(name) {
  document.getElementById('page-home').style.display = name === 'home' ? '' : 'none';
  document.getElementById('page-sell').style.display = name === 'sell' ? '' : 'none';
  document.getElementById('tab-btn-home').className = 'tab' + (name === 'home' ? ' active' : '');
  document.getElementById('tab-btn-sell').className = 'tab' + (name === 'sell' ? ' active' : '');
}
document.getElementById('tab-btn-home').addEventListener('click', function () { showTab('home'); });
document.getElementById('tab-btn-sell').addEventListener('click', function () { showTab('sell'); });

var sellState = { prod: null, qty: 1, payMode: 'full', customers: null };

function specText(specs) {
  return Object.keys(specs || {}).map(function (k) { return specs[k]; }).join(' · ');
}

var sellSearchTimer = null;
document.getElementById('sell-q').addEventListener('input', function (e) {
  clearTimeout(sellSearchTimer);
  var q = e.target.value.trim();
  if (!q) { document.getElementById('sell-result').innerHTML = ''; return; }
  sellSearchTimer = setTimeout(function () { doSellSearch(q, false); }, 300);
});

function doSellSearch(q, autoPick) {
  api('/api/inventory?q=' + encodeURIComponent(q)).then(function (items) {
    var box = document.getElementById('sell-result');
    box.innerHTML = '';
    if (!items.length) { box.innerHTML = '<div class="empty">没搜到，换个关键词试试</div>'; return; }
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'row pickable';
      var left = document.createElement('div');
      var n = document.createElement('div'); n.className = 'name'; n.textContent = it.name;
      var m = document.createElement('div'); m.className = 'meta';
      m.textContent = it.sku + (specText(it.specs) ? ' · ' + specText(it.specs) : '');
      left.appendChild(n); left.appendChild(m);
      var right = document.createElement('div'); right.className = 'num';
      right.innerHTML = '<span class="' + (it.stock < 5 ? 'red' : 'blue') + '">' + it.stock + ' 件</span>' +
        '<div class="time">' + yuan(it.suggestPrice) + '</div>';
      row.appendChild(left); row.appendChild(right);
      if (it.photoPath) row.insertBefore(photoImg(it.photoPath, 48), row.firstChild);
      row.addEventListener('click', function () { selectSell(it); });
      box.appendChild(row);
    });
    // 扫码直达：唯一结果或条码/SKU 精确命中 → 直接锁定进入开单，不用再点一次
    if (autoPick) {
      var hit = items.length === 1 ? items[0] : null;
      if (!hit) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].sku === q || items[i].barcode === q) { hit = items[i]; break; }
        }
      }
      if (hit) selectSell(hit);
    }
  }).catch(showErr);
}

function selectSell(it) {
  sellState.prod = it;
  sellState.qty = 1;
  document.getElementById('q-num').textContent = '1';
  document.getElementById('sell-name').textContent = it.name;
  document.getElementById('sell-meta').textContent =
    it.sku + ' · 库存 ' + it.stock + ' 件' + (specText(it.specs) ? ' · ' + specText(it.specs) : '');
  // 选中的商品带张大一点的图，认图不认字
  var sp = document.getElementById('sell-prod');
  var oldImg = sp.querySelector('img');
  if (oldImg) oldImg.remove();
  if (it.photoPath) sp.insertBefore(photoImg(it.photoPath, 56), sp.firstChild);
  document.getElementById('sell-price').value = it.suggestPrice != null ? (it.suggestPrice / 100).toFixed(2) : '';
  applyTierPrice();
  document.getElementById('sell-form').style.display = '';
  var done = document.getElementById('sell-done');
  done.innerHTML = '';
}

document.getElementById('q-minus').addEventListener('click', function () {
  if (sellState.qty > 1) sellState.qty--;
  document.getElementById('q-num').textContent = String(sellState.qty);
});
document.getElementById('q-plus').addEventListener('click', function () {
  sellState.qty++;
  document.getElementById('q-num').textContent = String(sellState.qty);
});

function setPayMode(mode) {
  sellState.payMode = mode;
  document.getElementById('pay-full').className = 'pay' + (mode === 'full' ? ' active' : '');
  document.getElementById('pay-credit').className = 'pay' + (mode === 'credit' ? ' active' : '');
  document.getElementById('credit-box').style.display = mode === 'credit' ? '' : 'none';
  if (mode === 'credit' && !sellState.customers) loadCustomers();
}
document.getElementById('pay-full').addEventListener('click', function () { setPayMode('full'); });
document.getElementById('pay-credit').addEventListener('click', function () { setPayMode('credit'); });

function loadCustomers() {
  api('/api/customers').then(function (list) {
    sellState.customers = list;
    var sel = document.getElementById('sell-cust');
    sel.innerHTML = '';
    if (!list.length) {
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = '（店里还没有客户档案，请先在电脑上建档）';
      sel.appendChild(o0);
      return;
    }
    list.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name + '（欠 ' + yuan(c.outstanding) + '）';
      sel.appendChild(o);
    });
    applyTierPrice();
  }).catch(showErr);
}
document.getElementById('sell-cust').addEventListener('change', applyTierPrice);

// 选了客户就自动应用他的价格档：该商品设了这档价就用档价，否则保持建议价/手填
function applyTierPrice() {
  var prod = sellState.prod;
  if (!prod || !sellState.customers) return;
  var sel = document.getElementById('sell-cust');
  var cust = null;
  for (var i = 0; i < sellState.customers.length; i++) {
    if (String(sellState.customers[i].id) === sel.value) { cust = sellState.customers[i]; break; }
  }
  if (cust && cust.priceLevel && prod.priceTiers && prod.priceTiers[cust.priceLevel] != null) {
    document.getElementById('sell-price').value = (prod.priceTiers[cust.priceLevel] / 100).toFixed(2);
  }
}

function parseYuan(v, label) {
  var n = parseFloat(String(v).trim());
  if (!(n >= 0)) { showErr(new Error('请填写正确的' + label)); return null; }
  return Math.round(n * 100);
}

var sellBtn = document.getElementById('sell-submit');
sellBtn.addEventListener('click', function () {
  if (sellBtn.disabled) return; // 防重复点击
  var prod = sellState.prod;
  if (!prod) return;
  var price = parseYuan(document.getElementById('sell-price').value, '单价');
  if (price == null) return;
  var body = { productId: prod.id, quantity: sellState.qty, sellingPrice: price };
  body.payMethod = document.getElementById('sell-method').value;
  if (sellState.payMode === 'credit') {
    var cid = parseInt(document.getElementById('sell-cust').value, 10);
    if (!cid) { showErr(new Error('欠款记账必须选择客户')); return; }
    var paid = parseYuan(document.getElementById('sell-paid').value || '0', '实收金额');
    if (paid == null) return;
    body.customerId = cid;
    body.paidAmount = paid;
  }
  sellBtn.disabled = true;
  sellBtn.textContent = '提交中…';
  fetch('/api/outbound?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) {
    return r.json().then(function (j) { return { status: r.status, j: j }; });
  }).then(function (res) {
    if (res.status === 401) throw new Error('访问密码不对，请用店里电脑上最新的二维码重新扫码打开');
    if (!res.j || !res.j.ok) throw new Error((res.j && res.j.error) || '开单失败（' + res.status + '）');
    var msg = '已卖出，应收 ' + yuan(res.j.totalDue);
    if (res.j.creditAmount > 0) msg += '<br>其中赊欠 ' + yuan(res.j.creditAmount);
    document.getElementById('sell-done').innerHTML = '<div class="done">' + msg + '</div>';
    // 重置开单区，顺手刷新看店数据（库存/今日流水已变）
    sellState.prod = null;
    document.getElementById('sell-form').style.display = 'none';
    document.getElementById('sell-q').value = '';
    document.getElementById('sell-result').innerHTML = '';
    setPayMode('full');
    loadAll();
  }).catch(showErr).finally(function () {
    sellBtn.disabled = false;
    sellBtn.textContent = '确认卖出';
  });
});

function loadAll() { loadSummary(); loadLowStock(); loadToday(); }
loadAll();
setInterval(loadAll, 30000);

// 扫码直达开单：贴纸二维码打开时自动切到卖货页并锁定商品
if (deepBarcode) {
  showTab('sell');
  document.getElementById('sell-q').value = deepBarcode;
  doSellSearch(deepBarcode, true);
}
</script>
</body>
</html>`

// ---------- 服务实例 ----------

/**
 * 创建局域网只读服务实例。
 * @param {{ db: import('node:sqlite').DatabaseSync, dataDir: string, basePort?: number }} opts
 *   db 注入业务库连接（照 commands.js 模式）；dataDir 用于存 token 与开关配置
 */
let aiRef = null // v1.15: main.js 注入 ai 模块引用，供 ai:photoDraft 桥接
let voiceRef = null // v2.4: main.js 注入 voice 模块引用，供手机端本地离线语音识别
let doubaoRef = null // v2.5: main.js 注入 doubao 模块引用，供手机端豆包视觉/ASR
let voiceOrderRef = null // P1-3: main.js 注入 voiceOrderService，供手机 POS 语音开单
/** 中心库服务端每日备份列表（backups/central-YYYYMMDD.db），只读 */
function listCenterBackups(dir) {
  // 兼容 dataDir={app}/data 与 {app} 两种：备份在 {app}/backups
  const candidates = [path.join(dir, 'backups'), path.join(dir, '..', 'backups')]
  const bdir = candidates.find((d) => { try { return fs.existsSync(d) } catch { return false } }) || candidates[0]
  let files = []
  try { files = fs.readdirSync(bdir).filter((f) => /^central-\d{8}\.db$/.test(f)) } catch { /* 无备份目录 */ }
  return files.sort().reverse().map((f) => {
    const m = /central-(\d{8})\.db/.exec(f)
    const size = fs.statSync(path.join(bdir, f)).size
    return { date: m ? m[1] : f, file: f, size }
  })
}

export function createInventoryServer({ db, dataDir, basePort = DEFAULT_PORT, webRoot = null, ai = null, voice = null, doubao = null, voiceOrder = null }) {
  // ---------- 幂等去重（防重复提交弄错钱）----------
  // 原实现是**进程内存 Map + 15 分钟 TTL**，注释自述「重启清空(可接受)」。2026-09-12 实测证伪：
  // 同一 idempotencyKey 在 pm2 restart 之后不再判重；而桌面(src/lib/offlineTransport.js)与手机
  // (electron/mobile/offline.js)两端的离线队列，都会在「写请求已记账但响应丢失」之后重放同一 key →
  // 「服务重启」比 15 分钟窗口更常发生（每次部署/崩溃），重复单据会真的落两次。
  // 现改为**落库**（表 idem），并把默认窗口放宽到 7 天（离线单据可能躺数天才重放）；
  // 可用 FI_IDEM_TTL_MS 覆盖。建表失败则退回内存 Map —— 绝不因幂等层把服务打挂。
  try { cmds.ensureUndoTable(db) } catch (e) { console.error('[server] 撤回表不可用:', e && e.message) }
  const IDEM_TTL = Number(process.env.FI_IDEM_TTL_MS || 7 * 24 * 3600 * 1000)
  let idemReady = false
  const idemFallback = new Map()
  try {
    db.prepare('CREATE TABLE IF NOT EXISTS idem (channel TEXT NOT NULL, "key" TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (channel, "key"))').run()
    db.prepare('DELETE FROM idem WHERE at < ?').run(Date.now() - IDEM_TTL)
    idemReady = true
  } catch (e) {
    console.error('[server] 幂等表不可用，退回内存（重启后不判重）:', e && e.message)
  }
  function idemCheck(channel, key) {
    const k = String(key ?? '')
    if (!k) return null
    if (idemReady) {
      try {
        const row = db.prepare('SELECT result, at FROM idem WHERE channel = ? AND "key" = ?').get(channel, k)
        if (!row || Date.now() - row.at >= IDEM_TTL) return null
        return { result: JSON.parse(row.result), at: row.at }
      } catch { return null }
    }
    const hit = idemFallback.get(channel + ':' + k)
    return hit && Date.now() - hit.at < IDEM_TTL ? hit : null
  }
  function idemSet(channel, key, result) {
    const k = String(key ?? '')
    if (!k) return
    if (idemReady) {
      try {
        db.prepare('INSERT INTO idem (channel, "key", result, at) VALUES (?,?,?,?) ON CONFLICT(channel, "key") DO UPDATE SET result = excluded.result, at = excluded.at').run(channel, k, JSON.stringify(result), Date.now())
        if (Math.random() < 0.01) db.prepare('DELETE FROM idem WHERE at < ?').run(Date.now() - IDEM_TTL)
      } catch { /* 落库失败不影响业务 */ }
      return
    }
    idemFallback.set(channel + ':' + k, { result, at: Date.now() })
    if (idemFallback.size > 5000) { for (const kk of idemFallback.keys()) if (Date.now() - idemFallback.get(kk).at > IDEM_TTL) idemFallback.delete(kk) }
  }
  if (ai) aiRef = ai
  if (voice) voiceRef = voice
  if (doubao) doubaoRef = doubao
  if (voiceOrder) voiceOrderRef = voiceOrder
  const tokenPath = path.join(dataDir, 'server-token.txt')
  const configPath = path.join(dataDir, 'server-config.json')
  // 商品图片只读出口：/api/photo?path=<相对文件名>，路径校验与桌面端 fi-img 协议共用 photo.js
  const photoStore = createPhotoStore(path.join(dataDir, 'images'))
  let server = null
  let port = null
  // HTTPS 服务（v2.8）：手机浏览器要麦克风/摄像头必须走 HTTPS，这里起一个加密服务给语音识别用
  let httpsServer = null
  let httpsPort = null
  let tlsReady = false
  // 任务6：HTTPS 启动失败原因（openssl 缺失等），暴露给设置页做明确提示
  let httpsStartError = null
  let token = null
  let lastError = null
  // 速率限制：ip → 最近一分钟内的请求时间戳
  const hits = new Map()
  // 写接口独立限流（更严）：ip → 最近一分钟内的写请求时间戳
  const writeHits = new Map()

  function loadConfig() {
    try {
      const c = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      return { enabled: c.enabled !== false }
    } catch {
      return { enabled: true } // 默认开启
    }
  }

  function saveConfig(enabled) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(configPath, JSON.stringify({ enabled }), 'utf8')
    } catch (e) {
      console.error('[server] 配置写入失败:', e)
    }
  }

  /** 首次启动生成 32 位随机 token，之后从文件复用；文件权限收紧为仅本人可读写 */
  function loadOrCreateToken() {
    try {
      const t = fs.readFileSync(tokenPath, 'utf8').trim()
      if (/^[0-9a-f]{32}$/.test(t)) return t
    } catch {
      // 文件不存在或读不了：走生成流程
    }
    const t = crypto.randomBytes(16).toString('hex')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(tokenPath, t, { mode: 0o600 })
    return t
  }

  function regenerateToken() {
    token = crypto.randomBytes(16).toString('hex')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(tokenPath, token, { mode: 0o600 })
    return status()
  }

  // ---------- P3 权限：只读 token（财务/只看账号）只能读，不能开单/入库等写操作 ----------
  let viewToken = null
  function loadOrCreateViewToken() {
    try {
      const t = fs.readFileSync(path.join(dataDir, 'server-view-token.txt'), 'utf8').trim()
      if (/^[0-9a-f]{32}$/.test(t)) return t
    } catch {}
    const t = crypto.randomBytes(16).toString('hex')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'server-view-token.txt'), t, { mode: 0o600 })
    return t
  }
  function tokenOkSingle(provided, t) {
    if (!t) return false
    const a = Buffer.from(String(provided)); const b = Buffer.from(t)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  function isViewToken(provided) { return tokenOkSingle(provided, viewToken) }
  // 写通道（只读 token 禁止调用）；其余通道视为只读
  const WRITE_CHANNELS = new Set([
    'product:create','product:update','product:batchUpdate','product:delete','product:mark','product:priceFromCost',
  'ai:applyConfig',
    'inbound:create','inbound:fromNote','outbound:confirm','outbound:checkout','outbound:return','outbound:exchange',
    'supplier:create','supplier:update','supplier:delete','supplier:pay',
    'stocktake:create','stocktake:updateItem','stocktake:complete','stocktake:submit','import:batch',
    // 库位调拨是写操作（改批次库位）—— 漏在这里等于只读令牌也能调拨
    'stock:transfer',
    // 撤回是写操作（会改库存/流水/商品表）—— 必须算写通道，否则只读令牌也能撤回
    'undo:apply',
    'customer:create','customer:update','customer:delete','payment:record',
    'expense:create','expense:update','expense:delete','waste:create',
    // 注：receipt:reconcile 是纯查询（commands/receipt.js 里只有 SELECT），原来误放在写通道，
    // 会让只读账号（财务）点「收款对账」直接 403。已移出。
    'part:set','part:setMany','kit:save','kit:delete','receipt:register',
    'po:create','po:receive','po:cancel','priceTier:set','priceTier:delete','photo:save','photo:delete',
    // 分类管理（2026-09-13 补）：这几条一直是写操作，但漏在白名单外 ——
    // 后果是**只读/视图令牌也能改分类**。顺手补齐（与 receipt:reconcile 那条注释同一个道理）。
    'category:create','category:rename','category:delete','category:move','category:setParent',
    // 员工账号与单位管理（2026-09-14 补进服务端时，一起登记为**写通道**）：
    // 漏在这里的后果与上面分类那批一样 —— **只读/视图令牌也能改员工和单位**。
    'user:create','user:update','user:delete','user:setStaffLogin',
    'unit:create','unit:update','unit:delete','unit:move',
    // 知识库与模板：都是写库
    'knowledge:save','knowledge:update','knowledge:delete','template:apply',
  ])

  function tokenOk(provided) {
    if (!provided) return false
    return tokenOkSingle(provided, token) || tokenOkSingle(provided, viewToken)
  }

  function rateLimited(ip, validToken) {
    // 任务7：合法 token 的请求按 token 维度限流（600/min，多设备同出口不误伤）；
    // 无 token/无效 token 按 IP 限流（120/min，防爆破）
    const key = validToken ? 'tok:' + validToken : 'ip:' + ip
    const limit = validToken ? TOKEN_RATE_LIMIT_PER_MIN : RATE_LIMIT_PER_MIN
    const nowMs = Date.now()
    const cutoff = nowMs - 60_000
    const list = (hits.get(key) ?? []).filter((t) => t > cutoff)
    if (list.length >= limit) {
      hits.set(key, list)
      return true
    }
    list.push(nowMs)
    hits.set(key, list)
    return false
  }

  /** 写接口限流：每 IP 每分钟 30 次（未授权的写尝试也计数，防爆破）；
   *  任务7+：带合法 token 的写请求按 token 维度放宽到 60/min（多设备同出口高峰开单不误伤） */
  function writeRateLimited(ip, validToken) {
    const key = validToken ? 'wtok:' + validToken : 'wip:' + ip
    const limit = validToken ? TOKEN_WRITE_RATE_LIMIT_PER_MIN : WRITE_RATE_LIMIT_PER_MIN
    const nowMs = Date.now()
    const cutoff = nowMs - 60_000
    const list = (writeHits.get(key) ?? []).filter((t) => t > cutoff)
    if (list.length >= limit) {
      writeHits.set(key, list)
      return true
    }
    list.push(nowMs)
    writeHits.set(key, list)
    return false
  }

  /** 读请求体，超过上限也读完再拒绝（避免半读状态污染连接复用） */
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let tooBig = false
      req.on('data', (c) => {
        size += c.length
        if (size > limit) {
          tooBig = true
          return // 继续吞掉剩余数据，不再累积
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (tooBig) reject(new Error('body too large'))
        else resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', reject)
    })
  }

  /** 第一个非内部 IPv4 地址（手机访问用）；拿不到回退 127.0.0.1 */
  function lanIp() {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) return ni.address
      }
    }
    return '127.0.0.1'
  }

  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'",
  }

  function sendJson(res, code, data) {
    res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  /** token 提取：?token= 或 x-token / Authorization: Bearer 头（读写接口同一套） */
  function tokenOf(req, url) {
    return (
      url.searchParams.get('token') ??
      req.headers['x-token'] ??
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null)
    )
  }

  /**
   * 手机开单（全系统唯一写接口）：{productId, quantity, sellingPrice?(分), customerId?, paidAmount?(分)}
   * sellingPrice 省略=商品建议零售价；paidAmount 省略=全额付清；部分付/0=赊账（必须选客户）。
   * 校验链：写限流 → token → Content-Type → 8KB 上限 → JSON → 字段白名单/类型 →
   * 业务校验与桌面端共用 commands.confirmOutbound（错误信息原样返回）。
   */
  const OUTBOUND_FIELDS = ['productId', 'quantity', 'sellingPrice', 'customerId', 'paidAmount', 'payMethod', 'idempotencyKey']
  async function handleOutbound(req, res, url) {
    const outboundToken = tokenOf(req, url)
    if (writeRateLimited(req.socket.remoteAddress ?? 'unknown', tokenOk(outboundToken) ? outboundToken : null)) {
      res.writeHead(429, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': '60',
      })
      res.end(JSON.stringify({ error: '操作太快，请稍等几秒再试', retryAfter: 60 }))
      return
    }
    if (!tokenOk(tokenOf(req, url))) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const ct = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!ct.startsWith('application/json')) {
      sendJson(res, 415, { error: 'Content-Type 必须是 application/json' })
      return
    }
    let raw
    try {
      raw = await readBody(req, MAX_BODY_BYTES)
    } catch {
      sendJson(res, 413, { error: `请求体超过 ${MAX_BODY_BYTES / 1024}KB 上限` })
      return
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { error: '请求体必须是 JSON 对象' })
      return
    }
    const unknown = Object.keys(body).filter((k) => !OUTBOUND_FIELDS.includes(k))
    if (unknown.length > 0) {
      sendJson(res, 400, { error: `未知字段：${unknown.join('、')}（只允许 ${OUTBOUND_FIELDS.join('/')}）` })
      return
    }
    // 幂等键：手机开单重复提交（网络重试/双击）返回上次结果，不重复扣库存/记账
    if (body.idempotencyKey) {
      const hit = idemCheck('outbound', body.idempotencyKey)
      if (hit) { sendJson(res, 200, Object.assign({ ok: true, idempotent: true }, hit.result)); return }
    }
    if (!Number.isInteger(body.productId) || body.productId <= 0) {
      sendJson(res, 400, { error: `productId 必须是正整数，收到：${body.productId}` })
      return
    }
    if (body.customerId != null && (!Number.isInteger(body.customerId) || body.customerId <= 0)) {
      sendJson(res, 400, { error: `customerId 必须是正整数，收到：${body.customerId}` })
      return
    }
    const prod = db.prepare('SELECT id, suggest_price FROM products WHERE id = ?').get(body.productId)
    if (!prod) {
      sendJson(res, 400, { error: '商品不存在' })
      return
    }
    // 售价省略 → 建议零售价（商品也没建议价则记 NULL，与桌面端"传 tier 回退"同口径）
    const sellingPrice = body.sellingPrice ?? prod.suggest_price ?? null
    try {
      const r = confirmOutbound(db, {
        productId: body.productId,
        quantity: body.quantity,
        sellingPrice,
        customerId: body.customerId ?? null,
        paidAmount: body.paidAmount ?? null,
        payMethod: body.payMethod ?? null,
        operator: '手机开单',
      })
      if (!r.ok) {
        sendJson(res, 409, { ok: false, error: `库存不足，还差 ${r.shortage} 件`, shortage: r.shortage })
        return
      }
      if (body.idempotencyKey) idemSet('outbound', body.idempotencyKey, { totalDue: r.totalDue, paidAmount: r.paidAmount, creditAmount: r.creditAmount })
      sendJson(res, 200, {
        ok: true,
        totalDue: r.totalDue,
        paidAmount: r.paidAmount,
        creditAmount: r.creditAmount,
      })
    } catch (e) {
      // 业务校验错误（数量/金额非法、赊账必须选客户等）原样返回中文提示
      sendJson(res, 400, { ok: false, error: e.message })
    }
  }

  // ---------- 局域网整机共享（方案 A）：桌面网页版托管 + 通用调用接口 ----------

  // 通用调用白名单：把桌面端 IPC 数据/业务通道镜像成 HTTP 接口（同一套 commands 业务校验）。
  // 语音/模型下载/系统对话框/本机备份恢复/AI 等主机本地能力不开放给局域网。
  const INVOKE_CHANNELS = {
    'data:loadAll': (d, p) => cmds.loadAll(d),
    'product:create': (d, p) => cmds.createProduct(d, p),
    'product:update': (d, p) => cmds.updateProduct(d, p.id, p),
    'product:batchUpdate': (d, p) => cmds.batchUpdateProducts(d, p),
    'product:delete': (d, p) => cmds.deleteProduct(d, p.id, p.operator ?? null),
    'product:mark': (d, p) => cmds.markProduct(d, p),
    'product:expiring': (d, p) => cmds.expiringProducts(d, p),
    'category:list': (d) => cmds.listCategories(d),
    // 分类写通道（2026-09-13 补）：以前只暴露了 category:list，
    // 于是**中心库模式下分类根本改不了**（分类管理页在中心库模式会打到一个不存在的通道）。
    'category:create': (d, p) => cmds.createCategory(d, p),
    'category:rename': (d, p) => cmds.renameCategory(d, p.id, p),
    'category:delete': (d, p) => cmds.deleteCategory(d, p.id, p.operator),
    'category:move': (d, p) => cmds.moveCategory(d, p.id, p.dir),
    'category:setParent': (d, p) => cmds.setCategoryParent(d, p.id, p),
    'unit:list': (d) => cmds.listUnits(d),
    'inbound:create': (d, p) => cmds.createInbound(d, p),
    // 进货单整单入库（2026-09-21）：AI 识别出的单据行，逐行入库。
    // 已有商品走 createInbound；识别不到的老货先建档（售价默认 成本×2，老板可再改），再入库。
    // 单行失败只记这一行（与 Excel 导入同样取舍），返回逐行结果让手机如实展示。
    'inbound:fromNote': (d, p) => {
      const items = Array.isArray(p?.items) ? p.items.slice(0, 60) : []
      if (!items.length) return { ok: false, reason: 'no-items' }
      const operator = p?.operator ?? null
      const out = { ok: true, done: 0, created: 0, failed: [], totalCost: 0 }
      for (const it of items) {
        try {
          const qty = Number(it.quantity)
          if (!(qty > 0)) throw new Error('数量要大于 0')
          const cost = Math.max(1, Math.round(Number(it.cost_price) || 0))
          let productId = Number(it.product_id) || null
          let created = false
          if (!productId) {
            const row = cmds.createProduct(d, {
              barcode: it.barcode || undefined,
              category: it.category || '其他',
              brand: it.brand || '',
              model: it.model || '',
              cost_price: cost,
              // 没给售价就按老板定的规矩 成本×2（开单页还能单件改）
              suggest_price: Math.max(1, Math.round(Number(it.suggest_price) || cost * 2)),
              unit: it.unit || '件',
              status: '待盘点',
              operator,
            })
            productId = row.id
            created = true
          }
          cmds.createInbound(d, { productId, quantity: qty, costPrice: cost, location: it.location || '', operator, expiryDate: it.expiry_date || undefined })
          out.done++
          if (created) out.created++
          out.totalCost += Math.round(cost * qty)
        } catch (e) {
          out.failed.push({ brand: it.brand || '', model: it.model || '', reason: String(e?.message ?? e) })
        }
      }
      return out
    },
    // 拍进货单 → AI 逐行识别（不落库；手机端核对后再调 inbound:fromNote）
    'ai:parseInboundNote': async (d, p) => {
      if (!aiRef) return { ok: false, reason: 'ai-not-ready' }
      if (!p?.imageBase64) return { ok: false, reason: 'no-image' }
      const r = await aiRef.parseInboundNote({ imageBase64: p.imageBase64, mimeType: p.mimeType || 'image/jpeg' })
      if (!r || !r.ok || !Array.isArray(r.items)) return r
      // AI 没匹配上的行，再做一次**本地兜底匹配**：按 品牌+型号 / 型号 / 品牌+型号连写 归一化比对。
      // 不匹配就给店里建新商品 —— 那会造出一堆和已有货重复的档案（老板最怕库乱）。
      const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\-_（）()【】\[\]·、,，.。/]/g, '')
      let all = []
      try { all = d.prepare('SELECT id, brand, model, sku_code, barcode FROM products').all() } catch (e) { all = [] }
      const byFull = new Map(), byModel = new Map(), byJoined = new Map()
      all.forEach((x) => {
        const b = norm(x.brand), m = norm(x.model)
        if (!m) return
        if (!byModel.has(m)) byModel.set(m, x)
        const joined = norm((x.brand || '') + (x.model || ''))
        if (joined && !byJoined.has(joined)) byJoined.set(joined, x)
        if (b && !byFull.has(b + '|' + m)) byFull.set(b + '|' + m, x)
      })
      const items = r.items.map((it) => {
        if (it.product_id) return Object.assign({}, it, { matched_by: 'ai' })
        const b = norm(it.brand), m = norm(it.model)
        let hit = (b && m && byFull.get(b + '|' + m)) || (m && byModel.get(m)) || (b && m && byJoined.get(b + m)) || null
        // 再放宽一档：品牌相同 + 型号互相包含 / 有 ≥3 字连续重叠 → 认成同一件货
        // （单子上写"伊势尼5号 有刺"，店里档案叫"伊势尼钩 有刺"，不给匹配就会建出重复档案）
        if (!hit && b) {
          const cands = all.filter((x) => norm(x.brand) === b)
          hit = cands.find((x) => { const mm = norm(x.model); return !!mm && !!m && (mm.includes(m) || m.includes(mm)) })
          if (!hit) {
            hit = cands.find((x) => {
              const mm = norm(x.model)
              if (!mm || !m) return false
              for (let i = 0; i + 3 <= m.length; i++) if (mm.includes(m.slice(i, i + 3))) return true
              return false
            })
          }
        }
        if (!hit) return Object.assign({}, it, { matched_by: null })
        return Object.assign({}, it, {
          product_id: hit.id, matched_by: 'local',
          matched_name: [hit.brand, hit.model].filter(Boolean).join(' ') || hit.sku_code,
        })
      })
      return Object.assign({}, r, { items })
    },
    // 应用 AI 配置（2026-09-21）：桌面端「设置 → AI 大模型」保存后推到中心库，
    // 手机端「小渔」用的就是这份配置（提供商 / API 地址 / 模型 / 密钥）。
    'ai:applyConfig': (d, p) => {
      if (!aiRef) return { ok: false, reason: 'ai-not-ready' }
      try {
        const provider = String(p?.provider || '').trim()
        if (provider) aiRef.setProvider(provider)
        if (p?.baseUrl !== undefined || p?.model !== undefined) {
          aiRef.setProviderEndpoint(provider || undefined, { baseUrl: p?.baseUrl, model: p?.model, visionModel: p?.visionModel })
        }
        if (p?.key) aiRef.setApiKey(String(p.key))
        return { ok: true, status: aiRef.aiStatus() }
      } catch (e) {
        return { ok: false, reason: String(e?.message ?? e) }
      }
    },
    'outbound:confirm': (d, p) => cmds.confirmOutbound(d, p),
    'outbound:checkout': (d, p) => cmds.confirmCheckout(d, p),
    'outbound:return': (d, p) => cmds.createReturn(d, p),
    'outbound:exchange': (d, p) => cmds.createExchange(d, p),
    'supplier:create': (d, p) => cmds.createSupplier(d, p),
    'supplier:update': (d, p) => cmds.updateSupplier(d, p.id, p),
    'supplier:delete': (d, p) => cmds.deleteSupplier(d, p.id),
    'supplier:pay': (d, p) => cmds.paySupplier(d, p),
    'supplier:payments': (d, p) => cmds.supplierPayments(d, p),
    'stocktake:create': (d, p) => cmds.createStockTake(d, p),
    'stocktake:updateItem': (d, p) => cmds.updateStockTakeItem(d, p),
    'stocktake:complete': (d, p) => cmds.completeStockTake(d, p.takeId),
    'stocktake:submit': (d, p) => cmds.submitStockTake(d, p),
    'import:batch': (d, p) => cmds.importBatch(d, p),
    // 库位调拨（2026-09-15）：备货出库/换库位专用 —— 只改批次库位，**不写 transactions**，
    // 所以营业额/毛利/库存金额都不受影响（详见 commands/stock.js 头部）。中心库模式下必须能用。
    'stock:transfer': (d, p) => cmds.transferStock(d, p),
    'stock:byLocation': (d, p) => cmds.stockByLocation(d, p?.productId),
    // 撤回（2026-09-20）：删商品/报损/入库留了可逆快照，误操作能一键还原。
    // 桌面端与手机端共用这两个通道（中心库模式下都走这里）。
    'undo:list': (d, p) => cmds.listUndo(d, p),
    'undo:apply': (d, p) => cmds.applyUndo(d, p?.id, p?.operator),
    'customer:create': (d, p) => cmds.createCustomer(d, p),
    'customer:update': (d, p) => cmds.updateCustomer(d, p),
    'customer:delete': (d, p) => cmds.deleteCustomer(d, p),
    'customer:list': (d) => cmds.listCustomers(d),
    'customer:statement': (d, p) => cmds.customerStatement(d, p),
    // 按成本批量定价（2026-09-20）：导入的库存只有成本没售价 → 开单每次都要现场输价。
    // 一次调用补一批，老板觉得不合适再单个改。
    'product:priceFromCost': (d, p) => cmds.priceFromCost(d, p ?? {}),
    'payment:record': (d, p) => cmds.recordPayment(d, p),
    'expense:create': (d, p) => cmds.createExpense(d, p),
    'expense:update': (d, p) => cmds.updateExpense(d, p),
    'expense:delete': (d, p) => cmds.deleteExpense(d, p),
    // ---- 手机端补全：报损（与桌面端同一套 commands，业务校验一致） ----
    'waste:create': (d, p) => cmds.createWaste(d, p),
    'waste:list': (d, p) => cmds.listWastes(d, p ?? {}),
    'waste:summary': (d, p) => cmds.wasteSummary(d, p ?? {}),
    'part:set': (d, p) => cmds.setPart(d, p),
    'part:setMany': (d, p) => cmds.setPartsMany(d, p),
    'part:list': (d, p) => cmds.partsOf(d, p ?? {}),
    'part:all': (d, p) => cmds.allParts(d, p ?? {}),
    'kit:list': (d) => cmds.listKits(d),
    'kit:get': (d, p) => cmds.getKit(d, p ?? {}),
    'kit:save': (d, p) => cmds.saveKit(d, p),
    'kit:delete': (d, p) => cmds.deleteKit(d, p ?? {}),
    'receipt:register': (d, p) => cmds.registerReceipt(d, p ?? {}),
    'receipt:list': (d, p) => cmds.listReceipts(d, p ?? {}),
    'receipt:reconcile': (d, p) => cmds.reconcileReceipt(d, p ?? {}),
    'po:create': (d, p) => cmds.createPurchaseOrder(d, p),
    'po:list': (d, p) => cmds.listPurchaseOrders(d, p),
    'po:detail': (d, p) => cmds.purchaseOrderDetail(d, p),
    'po:receive': (d, p) => cmds.receivePurchaseOrder(d, p),
    'po:cancel': (d, p) => cmds.cancelPurchaseOrder(d, p),
    'priceTier:set': (d, p) => cmds.setPriceTier(d, p),
    'priceTier:delete': (d, p) => cmds.deletePriceTier(d, p),
    'priceTier:list': (d, p) => cmds.getPriceTiers(d, p),
    'audit:list': (d, p) => cmds.auditLog(d, p),
    // 中心库服务端备份列表（桌面中心库模式「云端备份」用）
    'backup:list': (d, p) => listCenterBackups(dataDir),
    'supplier:statement': (d, p) => cmds.supplierStatement(d, p),
    // 商品图片：与桌面端主进程同款——写盘返回相对文件名 / 删文件+清 photo_path
    // 收款码：手机端开单选微信/支付宝时，读电脑上配好的收款码图展示给顾客扫
    'payment:getQr': (d) => {
      const readQr = (name) => {
        try {
          const p = path.join(dataDir, 'payment-qr', name)
          if (fs.existsSync(p)) return `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}`
        } catch { /* 当没配置 */ }
        return null
      }
      return { wx: readQr('wx.jpg'), ali: readQr('ali.jpg') }
    },
    'photo:save': (d, p) => ({ ok: true, path: photoStore.save(p?.productId, p?.base64, p?.ext ?? 'jpg') }),
    'photo:delete': (d, p) => {
      photoStore.remove(p?.productId)
      cmds.updateProduct(d, p?.productId, { photo_path: null })
      return { ok: true }
    },
    // ---- v1.15 手机端新通道（只读/桥接，零新业务逻辑） ----
    // ---- 安装/使用统计（2026-09-21）----
    // 手机端每次启动上报一次；只存「安装号 + 版本 + 平台 + 机型 + 首末时间 + 打开次数」，
    // 不采集任何经营数据。同时尽力转发官方统计（失败静默，绝不影响使用）。
    'app:ping': async (d, p) => {
      const id = String(p?.installId ?? '').trim().slice(0, 64)
      if (!id) return { ok: false, reason: 'no-install-id' }
      const ts = new Date().toISOString()
      try {
        d.exec(`CREATE TABLE IF NOT EXISTS app_installs (
          install_id TEXT PRIMARY KEY, first_at TEXT, last_at TEXT, launches INTEGER DEFAULT 0,
          version TEXT, web_version TEXT, platform TEXT, device TEXT)`)
        d.prepare(`INSERT INTO app_installs (install_id, first_at, last_at, launches, version, web_version, platform, device)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?)
            ON CONFLICT(install_id) DO UPDATE SET last_at = excluded.last_at, launches = launches + 1,
              version = excluded.version, web_version = excluded.web_version,
              platform = excluded.platform, device = excluded.device`)
          .run(id, ts, ts, String(p?.version ?? ''), String(p?.webVersion ?? ''), String(p?.platform ?? ''), String(p?.device ?? ''))
      } catch (e) { return { ok: false, reason: 'db-error', detail: String(e?.message ?? e) } }
      try {
        fetch('http://127.0.0.1:17533/api/v1/app/ping', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
          signal: AbortSignal.timeout(2500),
        }).catch(() => {})
      } catch (e) { /* 转发失败不影响使用 */ }
      return { ok: true }
    },
    // 使用情况：装了几台 / 今天几台在用 / 版本分布（本店自己的统计，来自本机账本的 app_installs 表）
    'app:stats': (d) => {
      try {
        d.exec(`CREATE TABLE IF NOT EXISTS app_installs (
          install_id TEXT PRIMARY KEY, first_at TEXT, last_at TEXT, launches INTEGER DEFAULT 0,
          version TEXT, web_version TEXT, platform TEXT, device TEXT)`)
        const day = (off = 0) => new Date(Date.now() - off * 86400000).toISOString().slice(0, 10)
        const one = (sql, ...args) => Object.values(d.prepare(sql).get(...args))[0]
        const days = []
        for (let i = 6; i >= 0; i--) {
          const dd = day(i)
          days.push({
            date: dd,
            active: one("SELECT COUNT(*) FROM app_installs WHERE date(last_at,'localtime') = ?", dd),
            added: one("SELECT COUNT(*) FROM app_installs WHERE date(first_at,'localtime') = ?", dd),
          })
        }
        return {
          devices: one('SELECT COUNT(*) FROM app_installs'),
          today: one("SELECT COUNT(*) FROM app_installs WHERE date(last_at,'localtime') = ?", day(0)),
          week: one("SELECT COUNT(*) FROM app_installs WHERE date(last_at,'localtime') >= ?", day(6)),
          launches: one('SELECT COALESCE(SUM(launches),0) FROM app_installs'),
          versions: d.prepare('SELECT version, COUNT(*) AS n FROM app_installs GROUP BY version ORDER BY n DESC LIMIT 8').all(),
          days,
        }
      } catch (e) { return { devices: 0, today: 0, week: 0, launches: 0, versions: [], days: [], error: String(e?.message ?? e) } }
    },
    'product:search': (d, p) => {
      const kw = String(p?.keyword ?? '').trim()
      if (!kw) return []
      const like = `%${kw}%`
      return d.prepare(
        `SELECT p.*, COALESCE((SELECT SUM(b2.quantity) FROM inventory_batches b2 WHERE b2.product_id = p.id),0) AS total_stock
         FROM products p WHERE p.sku_code = ? OR p.barcode = ? OR p.brand LIKE ? OR p.model LIKE ? OR p.sku_code LIKE ?
         LIMIT 20`
      ).all(kw, kw, like, like, like)
    },
    // 库存列表：keyword 空 = 全部商品（带总库存），非空 = 过滤；手机库存页"打开就看全部SKU"用
    'product:list': (d, p) => {
      const kw = String(p?.keyword ?? '').trim()
      const limit = Math.min(parseInt(p?.limit, 10) || 300, 1000)
      const base = `SELECT p.*, COALESCE((SELECT SUM(b2.quantity) FROM inventory_batches b2 WHERE b2.product_id = p.id),0) AS total_stock
         FROM products p`
      if (kw) {
        const like = `%${kw}%`
        return d.prepare(`${base} WHERE p.sku_code = ? OR p.barcode = ? OR p.brand LIKE ? OR p.model LIKE ? OR p.sku_code LIKE ? ORDER BY p.category, p.brand, p.model LIMIT ?`)
          .all(kw, kw, like, like, like, limit)
      }
      return d.prepare(`${base} ORDER BY p.category, p.brand, p.model LIMIT ?`).all(limit)
    },
    'report:today': (d) => {
      const rev = d.prepare(
        `SELECT COALESCE(SUM((CASE WHEN t.type='return' THEN -1 ELSE 1 END) * t.selling_price * t.quantity),0) FROM transactions t WHERE t.notes!='换货退旧' AND date(t.timestamp,'localtime')=date('now','localtime')`
      ).get()
      const profit = d.prepare(
        `SELECT COALESCE(SUM((CASE WHEN t.type='return' THEN -1 ELSE 1 END) * (t.selling_price - t.unit_price) * t.quantity),0) FROM transactions t WHERE t.notes!='换货退旧' AND date(t.timestamp,'localtime')=date('now','localtime')`
      ).get()
      const paySplit = cmds.todayPaymentSplit(d)
      const orders = d.prepare(
        `SELECT COUNT(*) AS n FROM (SELECT COUNT(*) FROM transactions t WHERE t.type='out' AND date(t.timestamp,'localtime')=date('now','localtime') GROUP BY t.id)`
      ).get()
      const recent = d.prepare(
        `SELECT t.type, t.quantity, t.selling_price, t.unit_price, t.timestamp, t.operator, t.notes, t.pay_method, p.brand, p.model, p.sku_code
         FROM transactions t JOIN products p ON p.id = t.product_id
         WHERE date(t.timestamp,'localtime') = date('now','localtime') ORDER BY t.timestamp DESC LIMIT 80`
      ).all()
      const receivable = d.prepare(
        `SELECT COALESCE(SUM(owed - paid),0) FROM (SELECT c.id, COALESCE((SELECT SUM(selling_price*quantity) FROM transactions WHERE customer_id=c.id),0) AS owed, COALESCE((SELECT SUM(paid_amount) FROM transactions WHERE customer_id=c.id),0) AS paid FROM customers c)`
      ).get()
      // 今日支出（expenses 按 expense_date 记）→ 净利 = 毛利 - 支出
      const expense = d.prepare(
        `SELECT COALESCE(SUM(amount),0) FROM expenses WHERE expense_date = date('now','localtime')`
      ).get()
      const profitVal = Object.values(profit)[0]
      return {
        revenue: Object.values(rev)[0], profit: profitVal,
        expense: Object.values(expense)[0],
        netProfit: profitVal - Object.values(expense)[0],
        paySplit, recent, receivable: Object.values(receivable)[0],
      }
    },
    'report:lowStock': (d) => cmds.lowStockProducts(d),
    // 收银台首页「快捷货架」：有销量 → 按销量排（真热销）；没有销量数据（新账/刚重开）→
    // 退回「有货的常用货」，把台面铺满，别让收银员对着空屏一个个搜。
    // 返回 { basis: 'sales'|'mixed'|'stock', items:[...] }，界面据此说实话（是热销还是只是有货）。
    'report:posQuickPicks': (d, p) => {
      const days = Math.min(Math.max(parseInt(p?.days, 10) || 30, 1), 90)
      const limit = Math.min(Math.max(parseInt(p?.limit, 10) || 9, 3), 24)
      const cols = 'p.id, p.brand, p.model, p.sku_code, p.suggest_price, p.photo_path, p.unit, p.category'
      const hot = d.prepare(
        `SELECT ${cols}, SUM(t.quantity) AS qty, SUM(t.selling_price * t.quantity) AS revenue
         FROM transactions t JOIN products p ON p.id = t.product_id
         WHERE t.type = 'out' AND date(t.timestamp,'localtime') >= date('now','localtime',?)
         GROUP BY t.product_id ORDER BY qty DESC LIMIT ?`,
      ).all(`-${days} days`, limit)
      if (hot.length >= limit) return { basis: 'sales', items: hot }
      const skip = new Set(hot.map((h) => h.id))
      const want = limit - hot.length
      // 常卖品类优先（渔具店：蚯蚓/饵料/冻饵/配件…），同品类内按「有货多少」排
      const pref = ['蚯蚓', '冻饵', '饵料', '配件', '鱼钩', '鱼线', '浮漂', '铅坠', '路亚', '假饵']
      const rest = d.prepare(
        `SELECT ${cols}, COALESCE(SUM(b.quantity),0) AS total_stock
         FROM products p LEFT JOIN inventory_batches b ON b.product_id = p.id AND b.quantity > 0
         WHERE p.status != '停产'
         GROUP BY p.id HAVING total_stock > 0`,
      ).all()
        .filter((r) => !skip.has(r.id))
        .map((r) => {
          const text = (r.category || '') + ' ' + (r.model || '') + ' ' + (r.brand || '') + ' ' + (r.sku_code || '')
          const idx = pref.findIndex((k) => text.includes(k))
          return { r, rank: idx < 0 ? 99 : idx }
        })
        .sort((a, b) => (a.rank - b.rank) || ((b.r.total_stock || 0) - (a.r.total_stock || 0)))
        .slice(0, want)
        .map((x) => x.r)
      return { basis: hot.length ? 'mixed' : 'stock', items: hot.concat(rest) }
    },
    'report:hotSellers': (d, p) => {
      const days = Math.min(Math.max(parseInt(p?.days, 10) || 30, 1), 90)
      return d.prepare(
        `SELECT p.id, p.brand, p.model, p.sku_code, p.suggest_price, p.photo_path, p.updated_at, p.unit,
                SUM(t.quantity) AS qty,
                SUM(t.selling_price * t.quantity) AS revenue
         FROM transactions t JOIN products p ON p.id = t.product_id
         WHERE t.type = 'out' AND date(t.timestamp,'localtime') >= date('now','localtime',?)
         GROUP BY t.product_id ORDER BY qty DESC LIMIT 9`
      ).all(`-${days} days`)
    },
    // 数据分析命令（与 /api/analytics/* 同源，供 invoke 与桌面、外部 Agent 调用）
    'analytics:trend': (d, p) => analyticsTrend(d, Number(p?.days) || 7),
    'analytics:category': (d) => analyticsCategory(d),
    'analytics:top': (d, p) => analyticsTop(d, Number(p?.n) || 10),
    'analytics:stockValue': (d) => analyticsStockValue(d),
    'analytics:overview': (d) => analyticsOverview(d),
    'supplier:list': (d) => {
      const rows = d.prepare(
        `SELECT s.id, s.name, s.phone,
         COALESCE((SELECT SUM(b.quantity * b.cost_price) FROM inventory_batches b WHERE b.supplier_id = s.id),0) AS total_cost
         FROM suppliers s ORDER BY s.name LIMIT 100`
      ).all()
      return rows
    },
    'ai:photoDraft': async (d, p) => {
      if (!aiRef || !p?.imageBase64) return { ok: false, reason: 'no-key-or-image' }
      // v3.0 每日额度（普通20/进阶100/大师不限）
      const quota = cmds.checkAiQuota(d, 'vision')
      if (!quota.allow) return { ok: false, reason: quota.message }
      try {
        const r = await aiRef.parseInboundNote({ imageBase64: p.imageBase64, mimeType: p.mimeType || 'image/jpeg' })
        if (r?.ok) cmds.recordAiUsage(d, 'vision')
        return r
      } catch (e) { return { ok: false, reason: e.message } }
    },
    // 手机端 AI 功能：状态 / 一句话日报 / 对话助手（与桌面端同一套 ai.js 逻辑）
    'ai:status': (d) => aiRef ? aiRef.aiStatus() : { configured: false },
    'ai:dailySummary': async (d, p) => {
      if (!aiRef) return { ok: false, reason: 'ai-not-ready' }
      try {
        return await aiRef.dailySummary(p?.stats ?? {})
      } catch (e) { return { ok: false, reason: e.message } }
    },
    'ai:chat': async (d, p) => {
      if (!aiRef) return { ok: false, reason: 'ai-not-ready' }
      try {
        // p.messages = [{role, content}]，返回 { ok, content, drafts, trace }
        return await aiRef.agentChat(Array.isArray(p?.messages) ? p.messages : [])
      } catch (e) { return { ok: false, reason: e.message } }
    },
    // 语音纠错：ASR 识别不准 → 用店里商品清单纠正成真实商品名（手机端语音搜索用）
    'ai:correctTerm': async (d, p) => {
      if (!aiRef || !p?.text) return { ok: false, reason: 'no-text' }
      try {
        return await aiRef.correctSearchTerm(p.text)
      } catch (e) { return { ok: false, reason: e.message } }
    },
    // 语音识别：本地离线（voice:transcribe，PC sherpa-onnx）+ 云端兜底（ai:transcribe，webm base64）
    'voice:status': (d) => voiceRef ? voiceRef.voiceStatus() : { ready: false },
    'voice:transcribe': async (d, p) => {
      if (!voiceRef || !Array.isArray(p?.pcm)) return { ok: false, reason: 'no-pcm' }
      try {
        // 把店里商品名（品牌+型号）拼成热词传进去，让识别器优先认商品名——口音识别不准时偏向商品
        const hotRows = d.prepare(
          `SELECT brand, model FROM products WHERE status != '停产' ORDER BY id LIMIT 500`,
        ).all()
        const hotwords = hotRows
          .map((r) => [r.brand, r.model].filter(Boolean).join(' ').trim())
          .filter(Boolean)
          .join(' ')
          .slice(0, 500) // 热词串过长反而拖慢，截断
        return await voiceRef.transcribePcm({ pcm: p.pcm, sampleRate: p.sampleRate || 16000, hotwords })
      } catch (e) { return { ok: false, reason: e.message } }
    },
    'ai:transcribe': async (d, p) => {
      if (!aiRef || !p?.audioBase64) return { ok: false, reason: 'no-audio' }
      try {
        // 手机端 webm base64 → 云端 ASR（本地模型没下载时的兜底）
        return await aiRef.transcribeAudio({ audioBase64: p.audioBase64, mimeType: p.mimeType || 'audio/webm' })
      } catch (e) { return { ok: false, reason: e.message } }
    },
    // 豆包语音转文字（火山方舟 doubao-asr-default）：本地小模型识别差时的云端增强
    'doubao:transcribe': async (d, p) => {
      if (!doubaoRef || !p?.audioBase64) return { ok: false, reason: 'no-audio' }
      try {
        return await doubaoRef.doubaoASR({ audioBase64: p.audioBase64, mimeType: p.mimeType || 'audio/webm' })
      } catch (e) { return { ok: false, reason: e.message } }
    },
    // P1-3 语音开单（手机 POS）：PCM base64 → 桌面端离线识别 + 解析草稿（音频不出店，落库仍走 outbound:checkout）
    'voice:parseOrderAudio': async (d, p) => {
      if (!voiceOrderRef) return { ok: false, reason: '语音开单不可用' }
      try {
        if (p?.audioBase64) {
          const buf = Buffer.from(String(p.audioBase64), 'base64')
          return await voiceOrderRef.parseOrderAudio({ pcm: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), sampleRate: p.sampleRate || 16000 })
        }
        if (p?.text) return await voiceOrderRef.parseOrderText(String(p.text))
        return { ok: false, reason: 'no-audio' }
      } catch (e) { return { ok: false, reason: e.message } }
    },

    // ===== 2026-09-14 补：中心库模式下原本"打到服务器 404"的那批（owner 反馈「设置里一堆功能不能用」）=====
    // 归服务端的判据：**这些通道的答案在服务端那份账上**。桌面端主进程里是同名的 commands.* 调用，
    // 所以两边口径一致（红线①：口径只走 electron/commands/）。
    // 注意：真正的"问本机"通道（app: / server: / license: / feedback: / 收款码图…）**不在这里**，
    // 它们在桌面端走本机 IPC（src/lib/api.ts 的 LOCAL_ONLY_CHANNELS），实现到服务端反而是错的。

    // 开单页的搜索框：本地兜底口径与桌面端共用一份（commands/search.js）
    'ai:smartSearch': (d, p) => localSearchHit(String(p?.text ?? '').trim(), productNamesForSearch(d)).result,

    // 分类管理：写通道早就在，**计数**这条一直漏（分类管理页要显示每个分类下多少货）
    'category:listWithCount': (d) => cmds.listCategoriesWithCount(d),

    // 清仓 / 定价建议（纯读；与桌面端同为 commands.buildXxx）
    'clearance:get': (d) => cmds.buildClearance(d),
    'pricing:get': (d) => cmds.buildPricing(d),

    // 知识库（店级数据；与桌面端同用 db.js 的助手）
    'knowledge:list': (d, p) => listInsights(d, p ?? {}),
    'knowledge:save': (d, p) => saveInsight(d, p.kind, p.content, { tags: p.tags ?? null, source: '手动' }),
    'knowledge:update': (d, p) => updateInsight(d, p.id, p),
    'knowledge:delete': (d, p) => deleteInsight(d, p.id),

    // 行业模板
    'template:list': () => cmds.listTemplates(),
    'template:apply': (d, p) => cmds.applyIndustryTemplate(d, p),

    // 单位管理（服务端原来只有 unit:list）
    'unit:create': (d, p) => cmds.createUnit(d, p),
    'unit:update': (d, p) => cmds.updateUnit(d, p.id, p),
    'unit:delete': (d, p) => cmds.deleteUnit(d, p.id, p.operator),
    'unit:move': (d, p) => cmds.moveUnit(d, p.id, p.dir),

    // 员工账号（店级：两台电脑必须看到同一份员工名单 —— 所以绝不能归本机）
    'user:list': (d) => cmds.listUsers(d),
    'user:current': (d) => cmds.currentUser(d),
    'user:create': (d, p) => cmds.createUser(d, p, p?.operator),
    'user:update': (d, p) => cmds.updateUser(d, p.id, p, p?.operator),
    'user:delete': (d, p) => cmds.deleteUser(d, p.id, p?.operator),
    'user:login': (d, p) => cmds.login(d, p),
    'user:logout': (d) => cmds.logout(d),
    'user:setStaffLogin': (d, p) => cmds.setStaffLogin(d, p.on, p?.operator),
    'user:staffLoginEnabled': (d) => cmds.staffLoginEnabled(d),
  }

  /** POST /api/invoke：{ channel, payload } → { ok:true, result }；业务错误 400 原样带中文提示 */
  async function handleInvoke(req, res, url) {
    if (!tokenOk(tokenOf(req, url))) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const ct = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!ct.startsWith('application/json')) {
      sendJson(res, 415, { error: 'Content-Type 必须是 application/json' })
      return
    }
    let raw
    try {
      raw = await readBody(req, MAX_INVOKE_BODY)
    } catch {
      sendJson(res, 413, { error: '请求体超过 2MB 上限' })
      return
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    // POST /api/command：{ name, params } 形式  转成 { channel, payload } 复用下面整套逻辑
    if (url.pathname === '/api/command' && typeof body?.name === 'string') {
      body = { channel: body.name, payload: body.params ?? {} }
    }
    const fn = typeof body?.channel === 'string' ? INVOKE_CHANNELS[body.channel] : undefined
    if (!fn) {
      sendJson(res, 404, { error: 'unknown channel' })
      return
    }
    if (isViewToken(tokenOf(req, url)) && WRITE_CHANNELS.has(body.channel)) {
      sendJson(res, 403, { ok: false, error: '只读账号：不能执行操作，仅可查看报表/库存' })
      return
    }
    // 幂等键：写接口携带 idempotencyKey（每次逻辑操作唯一）→ 网络重试/双击/重发返回上次结果，不重复记账（防"重复提交弄错钱"）
    const payload = body.payload ?? {}
    const idemKey = payload.idempotencyKey || body.idempotencyKey
    const cleanPayload = idemKey ? Object.assign({}, payload) : payload
    if (idemKey) delete cleanPayload.idempotencyKey
    const hit = idemKey ? idemCheck(body.channel, idemKey) : null
    if (hit) { sendJson(res, 200, { ok: true, result: hit.result, idempotent: true }); return }
    try {
      const result = await fn(db, cleanPayload)
      if (idemKey) idemSet(body.channel, idemKey, result)
      sendJson(res, 200, { ok: true, result })
    } catch (e) {
      // 业务校验错误（中文提示）原样返回，前端 catch 后直接展示
      sendJson(res, 400, { ok: false, error: e.message })
    }
  }

  /** GET /m：手机原生操作端。静态文件从 electron/mobile/ 目录读取，≤500KB 零依赖 */
  function serveMobile(res, pathname) {
    const mobileDir = path.join(__dirname, 'mobile')
    const rel = pathname === '/m' || pathname === '/m/' ? 'index.html' : pathname.slice('/m/'.length)
    if (rel.includes('..') || rel.includes('\\')) { sendJson(res, 404, { error: 'not found' }); return }
    const root = path.resolve(mobileDir)
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root + path.sep)) { sendJson(res, 404, { error: 'not found' }); return }
    try {
      const data = fs.readFileSync(abs)
      const mime = STATIC_MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
      // 手机端必须能加载本地 JS（app.js / pages / zxing），用 APP_CSP 而非默认 SECURITY_HEADERS——
      // 默认 CSP 的 script-src 'unsafe-inline' 会拦截所有 <script src>，导致手机端功能全空白
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Security-Policy': APP_CSP, 'Content-Type': mime, 'Cache-Control': 'no-cache' })
      res.end(data)
    } catch { sendJson(res, 404, { error: 'not found' }) }
  }

  /** GET /app：托管桌面网页版（dist）。代码公开、数据走 token，与手机页同一威胁模型 */
  function serveApp(res, pathname) {
    if (!webRoot) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    // HashRouter：前端路由全在 hash 里，/app 一律给 index.html，无 history 回退问题
    const rel = pathname === '/app' || pathname === '/app/' ? 'index.html' : pathname.slice('/app/'.length)
    // 防路径穿越：URL 已解码，拒绝 .. 与反斜杠；再用 resolve 双保险
    if (rel.includes('..') || rel.includes('\\')) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    const root = path.resolve(webRoot)
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root + path.sep)) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    let data
    try {
      data = fs.readFileSync(abs)
    } catch {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    const mime = STATIC_MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Security-Policy': APP_CSP, 'Content-Type': mime })
    res.end(data)
  }

  /**
 * 给 Agent 的**自描述入口**（GET /api/agent）—— 一次请求说清"怎么接"。
 *
 * 为什么要有它：命令 API 早就有了（`/api/commands` + `/api/invoke`），但接入方得读三份文档
 * 才知道"怎么鉴权、有哪几条路、哪些命令不能随便调"。这个端点把这些**从代码里现算**：
 * 命令总数、只读/写/本机清单都取自同一份注册表 —— 所以它不会像手写文档那样过期。
 */
function agentManifest() {
  let commands = []
  let restRoutes = []
  try {
    const r = listCommands({})
    commands = r.commands || []
    restRoutes = r.restRoutes || []
  } catch { /* 注册表读不到也回一个最小说明，绝不 500 —— 这个端点本身就是给人指路的 */ }
  const readOnly = commands.filter((c) => c.write === false).map((c) => c.name)
  const writes = commands.filter((c) => c.write !== false).map((c) => c.name)
  const localOnly = commands.filter((c) => c.local).map((c) => c.name)
  let version = ''
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || ''
  } catch { /* 打包与裸跑都可能读不到，不影响接入 */ }
  return {
    ok: true,
    service: 'AI 智能进销存系统',
    version,
    purpose: '门店进销存的业务接口。所有数字都来自命令层（electron/commands），与界面同源 —— 不存在第二套口径。',
    auth: {
      header: 'x-token: <令牌>',
      alt: '?token=<令牌> 也可以',
      missing: 'HTTP 401',
      where: '桌面机：%APPDATA%\\fishing-inventory\\server-token.txt（界面「设置 → 手机看店」也能看到）；中心库模式用中心库那台的令牌',
    },
    entries: {
      introspect: {
        list: 'GET /api/commands',
        one: 'GET /api/commands?name=<命令名>',
        filter: 'GET /api/commands?group=<前缀>&q=<关键词>',
      },
      invoke: {
        'POST /api/invoke': '{"channel":"<命令名>","payload":{...}}',
        'POST /api/command': '{"name":"<命令名>","params":{...}}',
        idempotency: 'body 里带 idempotencyKey：同一 key 重发第二次返回 idempotent:true（不会重复改账）',
        errors: { 业务失败: 'HTTP 400 + {ok:false,error}', 未知命令: 'HTTP 404' },
      },
      rest: restRoutes,
      cli: {
        path: 'scripts/inv-cli.mjs',
        examples: [
          'node scripts/inv-cli.mjs guide',
          'node scripts/inv-cli.mjs list --readonly',
          'node scripts/inv-cli.mjs doc <命令名>',
          'node scripts/inv-cli.mjs run product:list --params-file p.json',
          'node scripts/inv-cli.mjs run <写命令> --params-file p.json --yes',
        ],
      },
    },
    rules: {
      readOnly: 'write=false 的命令只查不改，可以直接调',
      write: 'write=true 的命令会改账/改库/改本机文件 —— 建议先向人汇报动作与参数，拿到同意再执行',
      localOnly: 'local=true 的命令只能在桌面机上调（中心库/手机打不到）',
      failSafe: '拿不到 write 标记时一律按写处理（CLI 就是这么做的）',
    },
    counts: {
      total: commands.length,
      readOnly: readOnly.length,
      write: writes.length,
      localOnly: localOnly.length,
      restRoutes: restRoutes.length,
    },
    readOnly,
    writes,
    localOnly,
    docs: ['docs/进销存系统Agent接入指南.md', 'docs/命令接口-接口文档.md'],
  }
}

async function handle(req, res) {
    // 跨域放行：只有显式配置 FI_CORS_ALLOW_ORIGINS 才生效（默认不输出任何 CORS 头）。
    // 用 setHeader：Node 里 writeHead 只覆盖它自己显式给出的头，setHeader 设过的会保留，
    // 所以这里设一次就够，不用动 sendJson 或任何既有函数签名。
    if (CORS_ORIGINS.length) {
      const reqOrigin = req.headers.origin
      if (reqOrigin && CORS_ORIGINS.includes(reqOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', reqOrigin)
        res.setHeader('Vary', 'Origin')
      }
      // 预检必须在方法白名单之前放行，否则 OPTIONS 会被下面判成 405
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'content-type,x-token,authorization',
          'Access-Control-Max-Age': '600',
        })
        res.end()
        return
      }
    }
    // 方法白名单：GET + 写接口 POST /api/outbound（手机开单）和 POST /api/invoke（整机共享），其余一律 405
    const url = new URL(req.url ?? '/', 'http://localhost')
    const isOutbound = req.method === 'POST' && url.pathname === '/api/outbound'
    // 通用命令入口（与 /api/invoke 同一套鉴权/限流/幂等/只读判断）
    const isInvoke = req.method === 'POST' && (url.pathname === '/api/invoke' || url.pathname === '/api/command')
    if (req.method !== 'GET' && !isOutbound && !isInvoke) {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    // /api/photo 不计速率限制：一页搜索结果可能带几十张缩略图，计入限流会把看店页刷崩
    // （token 鉴权照常在下面做，timingSafeEqual 防爆破不受影响）
    // 任务7：先取 token 并校验——有效 token 的请求按 token 维度限流（多设备同出口不误伤）
    const reqToken = tokenOf(req, url)
    const reqTokenValid = tokenOk(reqToken)
    if (url.pathname !== '/api/photo' && rateLimited(req.socket.remoteAddress ?? 'unknown', reqTokenValid ? reqToken : null)) {
      // 任务7：429 带 Retry-After 与友好中文提示（前端可据此展示，不静默失败）
      res.writeHead(429, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': '60',
      })
      res.end(JSON.stringify({ error: '操作太快，请稍等几秒再试', retryAfter: 60 }))
      return
    }
    if (isOutbound) {
      if (isViewToken(reqToken)) {
        res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: '只读账号：不能开单' }))
        return
      }
      await handleOutbound(req, res, url)
      return
    }
    if (isInvoke) {
      // 通用调用计入常规限流（120 次/分钟）：收银高频操作不被写接口的 30 次卡住，token 鉴权是真正的闸
      await handleInvoke(req, res, url)
      return
    }
    // 路径严格白名单：URL 解析后精确匹配，不存在路径穿越问题
    if (url.pathname === '/') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
      res.end(MOBILE_PAGE)
      return
    }
    // 桌面网页版（整机共享）：其他电脑/平板浏览器打开用全功能系统
    if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
      serveApp(res, url.pathname)
      return
    }
    // 手机端网址归一：/m（无斜杠）→ **308 跳到 /m/**（方案 1）。
    // 为什么必须跳：electron/mobile/index.html 用的是**相对路径**（offline.js / app.js / pages/*.js /
    // manifest.json / sw.js），这是**设计意图** —— 见 mobile/sw.js:2 的注释：
    // 「官网是 /m/sw.js（BASE=/m/），APK 是 /sw.js（BASE=/），同一份代码两端通吃」。
    // 但浏览器在 /m（无斜杠）时会把相对路径解析到**根目录**，于是 app.js 变成 /app.js → 404
    // → 所有脚本都加载不了 → 整页白屏（只剩 HTML 骨架）。实测 /app.js 确为 404、/m/app.js 为 200。
    // 308 = 永久重定向且**保留请求方法**（这里只有 GET，但语义正确，比 302 好）。
    // ⚠️ 必须带上 url.search：店里的二维码是 /m/?token=xxx，丢了 ?token= 就会白跳一次、然后 401。
    if (url.pathname === '/m') {
      res.writeHead(308, { ...SECURITY_HEADERS, Location: '/m/' + (url.search || '') })
      res.end()
      return
    }
    // 手机原生操作端（轻量单页应用，hash 路由，零依赖）
    if (url.pathname === '/m' || url.pathname === '/m/' || url.pathname.startsWith('/m/')) {
      serveMobile(res, url.pathname)
      return
    }
    // 商品图片（二进制端点，不走下面的 JSON 路由表）：token 鉴权 + resolvePath 防路径穿越，
    // 只放行 images 目录内 <数字>.<jpg/png/webp> 文件，找不到 404
    if (url.pathname === '/api/photo') {
      if (!tokenOk(tokenOf(req, url))) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      const abs = photoStore.resolvePath(url.searchParams.get('path'))
      if (!abs || !fs.existsSync(abs)) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const ext = path.extname(abs).slice(1).toLowerCase()
      res.writeHead(200, {
        'X-Content-Type-Options': 'nosniff',
        'Content-Type':
          ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
      })
      fs.createReadStream(abs).pipe(res)
      return
    }
    const ROUTES = {
      '/api/summary': () => querySummary(db),
      '/api/low-stock': () => queryLowStock(db),
      '/api/inventory': () => queryInventory(db, url.searchParams.get('q')),
      '/api/today': () => queryToday(db),
      '/api/customers': () => queryCustomers(db),
      '/api/audit': () => auditLog(db, { limit: 50 }),
      '/api/supplier-statement': () =>
        supplierStatement(db, { supplierId: Number(url.searchParams.get('id')) }),
      // 数据分析 REST（只读，图表/外部 Agent 同源取数）
      '/api/analytics/trend': () => analyticsTrend(db, Number(url.searchParams.get('days')) || 7),
      '/api/analytics/category': () => analyticsCategory(db),
      '/api/analytics/top': () => analyticsTop(db, Number(url.searchParams.get('n')) || 10),
      '/api/analytics/stockValue': () => analyticsStockValue(db),
      '/api/analytics/overview': () => analyticsOverview(db),
      // 中心库服务端备份列表（只读）：桌面「云端备份」在中心库模式下指到这里
      '/api/backup/list': () => listCenterBackups(dataDir),
      // 命令自省：全集 / 过滤 / 单条详情（?name=）。命令台与接口文档同源
      '/api/commands': () => {
        const nm = url.searchParams.get('name')
        if (nm) return describeCommand(nm)
        return listCommands({ group: url.searchParams.get('group') || '', q: url.searchParams.get('q') || '' })
      },
      // **给 Agent 的自描述入口**（2026-09-16）：一个请求就知道
      // "这是什么、怎么鉴权、有哪几条路能走、哪些命令随便跑、哪些要人点头、文档在哪"。
      // 目的是让接入方不必先读三份文档才能发第一条命令。
      '/api/agent': () => agentManifest(),
    }
    const route = ROUTES[url.pathname]
    if (!route) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    // token 鉴权：?token= 或 x-token / Authorization: Bearer 头
    if (!tokenOk(tokenOf(req, url))) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    try {
      sendJson(res, 200, route())
    } catch (e) {
      // 参数/业务校验错误（如供应商不存在）原样返回中文提示
      sendJson(res, 400, { error: e.message })
    }
  }

  /** 端口被占用时 +1 重试，最多 10 次；basePort=0 由系统分配（测试用） */
  function tryListen(p, attemptsLeft, secure = false) {
    return new Promise((resolve, reject) => {
      const create = () => {
        if (secure) {
          const { ok, cert, key } = ensureTlsCert(dataDir, lanIp())
          if (!ok) { tlsReady = false; return null }
          tlsReady = true
          return https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler)
        }
        return http.createServer(handler)
      }
      const s = create()
      if (!s) { reject(new Error('证书生成失败，HTTPS 不可用')); return }
      s.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attemptsLeft > 0 && p !== 0) {
          resolve(tryListen(p + 1, attemptsLeft - 1, secure))
        } else {
          reject(e)
        }
      })
      s.listen(p, '0.0.0.0', () => {
        s.removeAllListeners('error')
        resolve({ server: s, port: s.address().port })
      })
    })
  }

  // 统一请求处理（http/https 共用）
  const handler = (req, res) => {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch((e) => {
        console.error('[server] 请求处理异常:', e)
        try {
          sendJson(res, 500, { error: 'internal error' })
        } catch {
          // 连接已断开等情况，忽略
        }
      })
  }

  async function start() {
    if (server) return status()
    if (!loadConfig().enabled) return status()
    token = loadOrCreateToken()
    viewToken = loadOrCreateViewToken()
    try {
      const r = await tryListen(basePort, MAX_PORT_RETRY - 1)
      server = r.server
      port = r.port
      // HTTPS 服务（语音/摄像头必需）：在 HTTP 端口+1 上起；失败只告警不阻断 HTTP 看店
      try {
        const rh = await tryListen(basePort + 1, MAX_PORT_RETRY - 1, true)
        httpsServer = rh.server
        httpsPort = rh.port
        console.log(`[server] 手机看店(HTTPS)已启动：https://${lanIp()}:${httpsPort}`)
      } catch (e) {
        httpsServer = null
        httpsPort = null
        // 任务6：记录失败原因（openssl 缺失等），设置页展示「语音需 HTTPS」的明确指引
        httpsStartError = /openssl|spawn|ENOENT/i.test(String(e?.message ?? ''))
          ? '未找到 openssl，语音/摄像头功能不可用。请安装 Git（自带 openssl）后重启应用'
          : (e?.message ?? 'HTTPS 不可用')
        console.warn('[server] HTTPS 启动失败（语音需 HTTPS，HTTP 看店不受影响）:', e.message)
      }
      lastError = null
      console.log(`[server] 手机看店服务已启动：http://${lanIp()}:${port}`)
    } catch (e) {
      lastError = e.message
      console.error('[server] 启动失败:', e)
    }
    return status()
  }

  async function stop() {
    if (httpsServer) {
      try { await new Promise((r) => httpsServer.close(r)) } catch {}
      httpsServer = null
      httpsPort = null
    }
    if (!server) return status()
    const s = server
    server = null
    port = null
    await new Promise((resolve) => s.close(resolve))
    return status()
  }

  async function setEnabled(enabled) {
    saveConfig(enabled)
    if (enabled) return start()
    return stop()
  }

  function status() {
    const enabled = loadConfig().enabled
    const running = server !== null
    const ip = lanIp()
    return {
      enabled,
      running,
      port: running ? port : null,
      ip,
      // 优先 HTTPS（语音/摄像头要用）；HTTPS 不可用时退回 HTTP
      url: running && httpsPort ? `https://${ip}:${httpsPort}/?token=${token}` : running ? `http://${ip}:${port}/?token=${token}` : null,
      httpUrl: running ? `http://${ip}:${port}/?token=${token}` : null,
      httpsPort: running ? httpsPort : null,
      httpsEnabled: running && !!httpsPort,
      // 任务6（审计 2026-08-30）：HTTPS 启动失败原因（openssl 缺失等），前端展示明确提示
      httpsError: running && !httpsPort ? (httpsStartError || 'HTTPS 不可用') : null,
      // 整机共享：其他电脑/平板浏览器用这个网址开全功能系统
      appUrl: running && webRoot ? (httpsPort ? `https://${ip}:${httpsPort}/app?token=${token}` : `http://${ip}:${port}/app?token=${token}`) : null,
      error: lastError,
    }
  }

  return { start, stop, setEnabled, regenerateToken, status }
}