#!/usr/bin/env node
// 进销存数据分析 CLI（inv-analytics）：只读本地 SQLite，输出经营分析数据。
// 供驾驶舱 / 运营 Agent 读取真实数据：销售额、毛利、库存、首单状态、客户欠款、低库存、临期。
// 用法：
//   node scripts/inv-analytics.mjs overview                经营总览（今天/本月/累计）
//   node scripts/inv-analytics.mjs sales --days 7          近 N 天销售趋势
//   node scripts/inv-analytics.mjs stock                   库存概览（总值/低库存/临期/滞销）
//   node scripts/inv-analytics.mjs first-sale              首单状态（有没有卖出去过）
//   node scripts/inv-analytics.mjs customers                客户欠款排行
//   node scripts/inv-analytics.mjs top --n 10               畅销品 Top
//   node scripts/inv-analytics.mjs raw --sql "SELECT ..."   原始查询（只读）
// 输出：JSON（Agent 易解析）；--pretty 输出人类可读表格
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'

const DB_PATH = path.join(process.env.APPDATA || os.homedir(), 'fishing-inventory', 'data.db')

// ---------- 工具 ----------

function openDb() {
  if (!process.env.APPDATA) {
    // 非 Windows 回退到默认
  }
  return new DatabaseSync(DB_PATH, { readOnly: true })
}

const Y = 100 // 金额单位：分 → 元
const fmt = (cents) => (cents / Y).toFixed(2)
const todayKey = () => {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}
const localDay = (iso) => {
  // timestamp 可能是 'YYYY-MM-DD HH:MM:SS' 本地时区
  return String(iso || '').slice(0, 10)
}

// ---------- 命令 ----------

function cmdOverview(db) {
  const t = todayKey()
  const month = t.slice(0, 7)
  // 今日销售
  const today = db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN type='out' THEN quantity*selling_price ELSE 0 END),0) AS revenue, COALESCE(SUM(CASE WHEN type='out' THEN quantity*(selling_price-unit_price) ELSE 0 END),0) AS profit, COALESCE(SUM(CASE WHEN type='out' THEN quantity ELSE 0 END),0) AS qty FROM transactions WHERE substr(timestamp,1,10)=?"
  ).get(t)
  // 本月
  const monthRow = db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN type='out' THEN quantity*selling_price ELSE 0 END),0) AS revenue, COALESCE(SUM(CASE WHEN type='out' THEN quantity*(selling_price-unit_price) ELSE 0 END),0) AS profit, COUNT(DISTINCT CASE WHEN type='out' THEN product_id END) AS skuSold FROM transactions WHERE substr(timestamp,1,7)=?"
  ).get(month)
  // 累计
  const total = db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN type='out' THEN quantity*selling_price ELSE 0 END),0) AS revenue, COALESCE(SUM(CASE WHEN type='out' THEN quantity ELSE 0 END),0) AS qty FROM transactions"
  ).get()
  // 库存总值（批次进价）
  const stock = db.prepare(
    "SELECT COALESCE(SUM(quantity*cost_price),0) AS value, COALESCE(SUM(quantity),0) AS qty FROM inventory_batches"
  ).get()
  // 商品数
  const products = db.prepare("SELECT COUNT(*) AS n FROM products").get().n
  // 今日入库
  const todayIn = db.prepare(
    "SELECT COALESCE(SUM(quantity),0) AS qty FROM transactions WHERE type='in' AND substr(timestamp,1,10)=?"
  ).get(t).qty
  return {
    date: t,
    today: { revenue: fmt(today.revenue), profit: fmt(today.profit), qty: today.qty, inboundQty: todayIn },
    month: { revenue: fmt(monthRow.revenue), profit: fmt(monthRow.profit), skuSold: monthRow.skuSold },
    total: { revenue: fmt(total.revenue), qty: total.qty },
    stock: { value: fmt(stock.value), qty: stock.qty },
    productCount: products,
  }
}

function cmdSales(db, days) {
  const n = Math.min(Math.max(days || 7, 1), 90)
  const rows = db.prepare(
    "SELECT substr(timestamp,1,10) AS d, SUM(CASE WHEN type='out' THEN quantity*selling_price ELSE 0 END) AS revenue, SUM(CASE WHEN type='out' THEN quantity*(selling_price-unit_price) ELSE 0 END) AS profit FROM transactions WHERE substr(timestamp,1,10) >= date('now','localtime', ?) GROUP BY d ORDER BY d"
  ).all('-' + (n - 1) + ' days')
  return { days: n, series: rows.map(r => ({ date: r.d, revenue: fmt(r.revenue), profit: fmt(r.profit) })) }
}

function cmdStock(db) {
  const low = db.prepare(
    "SELECT p.id, p.sku_code, p.brand, p.model, p.category, COALESCE(s.q,0) AS stock, COALESCE(p.min_stock,5) AS min_stock FROM products p LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_batches GROUP BY product_id) s ON s.product_id=p.id WHERE p.status != '停产' AND COALESCE(s.q,0) < COALESCE(p.min_stock,5) ORDER BY stock LIMIT 20"
  ).all()
  const expiring = db.prepare(
    "SELECT p.sku_code, p.brand, p.model, SUM(b.quantity) AS qty, MIN(b.expiry_date) AS earliest FROM inventory_batches b JOIN products p ON p.id=b.product_id WHERE b.expiry_date IS NOT NULL AND b.expiry_date <= date('now','localtime','+30 days') GROUP BY b.product_id ORDER BY earliest LIMIT 20"
  ).all()
  // 滞销：有库存但 90 天没卖
  const slow = db.prepare(
    "SELECT p.id, p.sku_code, p.brand, p.model, COALESCE(s.q,0) AS stock FROM products p LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_batches GROUP BY product_id) s ON s.product_id=p.id WHERE COALESCE(s.q,0) > 0 AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.product_id=p.id AND t.type='out' AND t.timestamp >= date('now','localtime','-90 days')) ORDER BY stock DESC LIMIT 20"
  ).all()
  return { lowStock: low.map(r => ({ ...r, stock: r.stock ?? 0 })), expiring: expiring.map(r => ({ ...r, qty: r.qty ?? 0 })), slowMoving: slow.map(r => ({ ...r, stock: r.stock ?? 0 })) }
}

function cmdFirstSale(db) {
  const first = db.prepare(
    "SELECT MIN(timestamp) AS firstSaleAt, COUNT(*) AS outCount FROM transactions WHERE type='out'"
  ).get()
  return {
    hasFirstSale: first.outCount > 0,
    firstSaleAt: first.firstSaleAt || null,
    outCount: first.outCount || 0,
  }
}

// 沉睡资金榜：有库存但 N 天无出库的商品 × 库存数量 × 批次成本，按金额倒序（周掌柜审计 2026-08-28）
// 子查询先聚合出 stock/占用资金/最后售出时间，外层按天数过滤（SQLite HAVING 不认聚合别名）
function cmdDormant(db, days90, days180) {
  // 任务8（审计 2026-08-30）：数据窗口检测——系统启用以来没有任何销售流水时，
  // 沉睡榜 100% 命中是"库存占用快照"而非真实滞销警报，必须显式提示而非假装发现问题。
  const anySale = db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'out'")
    .get().n
  const firstIn = db
    .prepare("SELECT MIN(timestamp) AS t FROM transactions WHERE type = 'in'")
    .get().t
  if (anySale === 0) {
    return {
      days: { slow: days90, dead: days180 },
      dataWindow: {
        hasSales: false,
        note: '系统启用以来无销售流水（暂无出库记录），以下为库存占用快照，非滞销判定；启用销售后榜单自动转为真实滞销分析',
        firstInboundAt: firstIn ? firstIn.slice(0, 10) : null,
        totalTiedCapital: fmt(
          db.prepare('SELECT COALESCE(SUM(b.quantity * b.cost_price), 0) AS v FROM inventory_batches b JOIN products p ON p.id = b.product_id WHERE p.status != ?')
            .get('停产').v,
        ),
      },
      totalTiedSlow: '—',
      totalTiedDead: '—',
      count: 0,
      items: [],
    }
  }
  const baseSql = `
    SELECT * FROM (
      SELECT p.id, p.sku_code, p.brand, p.model, p.category,
        SUM(b.quantity) AS stock,
        CAST(SUM(b.quantity * b.cost_price) AS INTEGER) AS tiedCapital,
        (SELECT MAX(t.timestamp) FROM transactions t WHERE t.product_id = p.id AND t.type = 'out') AS lastSold
      FROM products p
      JOIN inventory_batches b ON b.product_id = p.id
      WHERE p.status != '停产'
      GROUP BY p.id
    )
    WHERE stock > 0 AND (lastSold IS NULL OR substr(lastSold, 1, 10) < date('now', 'localtime', ?))
    ORDER BY tiedCapital DESC`
  const rows = db.prepare(baseSql).all('-' + days90 + ' days')
  const rows180 = db.prepare(baseSql).all('-' + days180 + ' days')
  const totalSlow = rows.reduce((s, r) => s + (r.tiedCapital || 0), 0)
  const totalDead = rows180.reduce((s, r) => s + (r.tiedCapital || 0), 0)
  const dead180 = new Map(rows180.map((r) => [r.id, r]))
  return {
    days: { slow: days90, dead: days180 },
    dataWindow: { hasSales: true },
    totalTiedSlow: fmt(totalSlow),
    totalTiedDead: fmt(totalDead),
    count: rows.length,
    items: rows.map((r) => ({
      sku: r.sku_code, brand: r.brand, model: r.model, category: r.category,
      stock: r.stock, tiedCapital: fmt(r.tiedCapital),
      lastSold: r.lastSold ? r.lastSold.slice(0, 10) : '从未售出',
      tier: dead180.has(r.id) ? '180天+' : '90天+',
    })),
  }
}

function cmdCustomers(db) {
  const rows = db.prepare(
    "SELECT c.id, c.name, c.phone, COALESCE(SUM(p.amount),0) AS paid, (SELECT COALESCE(SUM(t.quantity*t.selling_price),0) FROM transactions t WHERE t.customer_id=c.id AND t.type='out') AS bought, COALESCE((SELECT SUM(t.quantity*t.selling_price) FROM transactions t WHERE t.customer_id=c.id AND t.type='out'),0) - COALESCE(SUM(p.amount),0) AS debt FROM customers c LEFT JOIN payments p ON p.customer_id=c.id GROUP BY c.id HAVING debt > 0 ORDER BY debt DESC LIMIT 20"
  ).all()
  return rows.map(r => ({ id: r.id, name: r.name, phone: r.phone, bought: fmt(r.bought), paid: fmt(r.paid), debt: fmt(r.debt) }))
}

function cmdTop(db, n) {
  const rows = db.prepare(
    "SELECT p.sku_code, p.brand, p.model, SUM(t.quantity) AS qty, SUM(t.quantity*t.selling_price) AS revenue FROM transactions t JOIN products p ON p.id=t.product_id WHERE t.type='out' GROUP BY t.product_id ORDER BY revenue DESC LIMIT ?"
  ).all(n)
  return rows.map(r => ({ sku: r.sku_code, brand: r.brand, model: r.model, qty: r.qty, revenue: fmt(r.revenue) }))
}

function cmdRaw(db, sql) {
  if (!sql) throw new Error('raw 需要 --sql 参数')
  // 只读保护：拒绝非 SELECT
  if (!/^\s*select/i.test(sql)) throw new Error('raw 只允许 SELECT 查询（只读）')
  const stmt = db.prepare(sql)
  const cols = stmt.columns().map(c => c.name)
  return { columns: cols, rows: stmt.all() }
}

// ---------- 主流程 ----------

const args = process.argv.slice(2)
const pretty = args.includes('--pretty')
const cmd = args.find(a => !a.startsWith('-')) || 'help'
function flag(name) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : null
}

let db
try {
  db = openDb()
  let result
  switch (cmd) {
    case 'overview': result = cmdOverview(db); break
    case 'sales': result = cmdSales(db, parseInt(flag('days') || '7', 10)); break
    case 'stock': result = cmdStock(db); break
    case 'first-sale': result = cmdFirstSale(db); break
    case 'customers': result = cmdCustomers(db); break
    case 'dormant': result = cmdDormant(db, parseInt(flag('slow') || '90', 10), parseInt(flag('dead') || '180', 10)); break
    case 'top': result = cmdTop(db, parseInt(flag('n') || '10', 10)); break
    case 'raw': result = cmdRaw(db, flag('sql')); break
    case 'help':
    default:
      console.log(`进销存数据分析 CLI（inv-analytics）— 只读查询真实经营数据
==========================================
用法:
  node scripts/inv-analytics.mjs overview           经营总览（今天/本月/累计/库存/商品数）
  node scripts/inv-analytics.mjs sales --days 7     近 N 天销售趋势
  node scripts/inv-analytics.mjs stock              库存概览（低库存/临期/滞销）
  node scripts/inv-analytics.mjs first-sale         首单状态（判断任务完成依据）
  node scripts/inv-analytics.mjs customers          客户欠款排行
  node scripts/inv-analytics.mjs dormant            沉睡资金榜（90/180天无出库 × 占用资金，倒序）
  node scripts/inv-analytics.mjs top --n 10         畅销品 Top N
  node scripts/inv-analytics.mjs raw --sql "SELECT ..."  原始只读查询
  --pretty    人类可读输出（默认 JSON）
数据源: %APPDATA%/fishing-inventory/data.db (SQLite, 只读)
`)
      process.exit(0)
  }
  if (pretty) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(JSON.stringify(result))
  }
} catch (e) {
  console.error('ERR: ' + e.message)
  process.exit(1)
} finally {
  if (db) try { db.close() } catch { /* ignore */ }
}
