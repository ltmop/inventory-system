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
import { ensureTlsCert } from './tls.js'

// ESM 无 __dirname，这里补一个（serveMobile 托管 electron/mobile/ 用）
const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { confirmOutbound, listCustomers, lowStockProducts, auditLog, supplierStatement, todayPaymentSplit } from './commands.js'
import * as cmds from './commands.js'
import { createPhotoStore } from './photo.js'

const DEFAULT_PORT = 17532
const MAX_PORT_RETRY = 10
const RATE_LIMIT_PER_MIN = 120
// 写接口独立限流（更严）与请求体上限
const WRITE_RATE_LIMIT_PER_MIN = 30
const MAX_BODY_BYTES = 8192
// 通用调用接口（/api/invoke）请求体上限：批量导入/商品图片 base64 会到几百 KB
const MAX_INVOKE_BODY = 2 * 1024 * 1024

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
export function createInventoryServer({ db, dataDir, basePort = DEFAULT_PORT, webRoot = null, ai = null, voice = null, doubao = null }) {
  if (ai) aiRef = ai
  if (voice) voiceRef = voice
  if (doubao) doubaoRef = doubao
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

  function tokenOk(provided) {
    if (!provided || !token) return false
    const a = Buffer.from(String(provided))
    const b = Buffer.from(token)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  function rateLimited(ip) {
    const nowMs = Date.now()
    const cutoff = nowMs - 60_000
    const list = (hits.get(ip) ?? []).filter((t) => t > cutoff)
    if (list.length >= RATE_LIMIT_PER_MIN) {
      hits.set(ip, list)
      return true
    }
    list.push(nowMs)
    hits.set(ip, list)
    return false
  }

  /** 写接口限流：每 IP 每分钟 30 次（未授权的写尝试也计数，防爆破） */
  function writeRateLimited(ip) {
    const nowMs = Date.now()
    const cutoff = nowMs - 60_000
    const list = (writeHits.get(ip) ?? []).filter((t) => t > cutoff)
    if (list.length >= WRITE_RATE_LIMIT_PER_MIN) {
      writeHits.set(ip, list)
      return true
    }
    list.push(nowMs)
    writeHits.set(ip, list)
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
  const OUTBOUND_FIELDS = ['productId', 'quantity', 'sellingPrice', 'customerId', 'paidAmount', 'payMethod']
  async function handleOutbound(req, res, url) {
    if (writeRateLimited(req.socket.remoteAddress ?? 'unknown')) {
      sendJson(res, 429, { error: 'too many requests' })
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
    'unit:list': (d) => cmds.listUnits(d),
    'inbound:create': (d, p) => cmds.createInbound(d, p),
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
    'customer:create': (d, p) => cmds.createCustomer(d, p),
    'customer:update': (d, p) => cmds.updateCustomer(d, p),
    'customer:delete': (d, p) => cmds.deleteCustomer(d, p),
    'customer:list': (d) => cmds.listCustomers(d),
    'customer:statement': (d, p) => cmds.customerStatement(d, p),
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
    const fn = typeof body?.channel === 'string' ? INVOKE_CHANNELS[body.channel] : undefined
    if (!fn) {
      sendJson(res, 404, { error: 'unknown channel' })
      return
    }
    try {
      const result = await fn(db, body.payload ?? {})
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

  async function handle(req, res) {
    // 方法白名单：GET + 写接口 POST /api/outbound（手机开单）和 POST /api/invoke（整机共享），其余一律 405
    const url = new URL(req.url ?? '/', 'http://localhost')
    const isOutbound = req.method === 'POST' && url.pathname === '/api/outbound'
    const isInvoke = req.method === 'POST' && url.pathname === '/api/invoke'
    if (req.method !== 'GET' && !isOutbound && !isInvoke) {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    // /api/photo 不计速率限制：一页搜索结果可能带几十张缩略图，计入 120 次/分钟会把看店页刷崩
    // （token 鉴权照常在下面做，timingSafeEqual 防爆破不受影响）
    if (url.pathname !== '/api/photo' && rateLimited(req.socket.remoteAddress ?? 'unknown')) {
      sendJson(res, 429, { error: 'too many requests' })
      return
    }
    if (isOutbound) {
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
      // 整机共享：其他电脑/平板浏览器用这个网址开全功能系统
      appUrl: running && webRoot ? (httpsPort ? `https://${ip}:${httpsPort}/app?token=${token}` : `http://${ip}:${port}/app?token=${token}`) : null,
      error: lastError,
    }
  }

  return { start, stop, setEnabled, regenerateToken, status }
}
