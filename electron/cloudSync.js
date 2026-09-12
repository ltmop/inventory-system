/**
 * 多端同步引擎  阶段二之二
 *
 * 职责：把"本机改了什么"（sync_changelog）逐条加密推给服务端，并把别的设备改的东西拉回来落到本机。
 * 设计约束：
 *    只新增文件、不碰 cloud.js 既有逻辑（那边还在别的窗口手上）
 *    载荷里**外键用 guid 表达**（本地整数 id 只在本机有意义，跨设备传等于传垃圾）
 *    引擎自己的写入**绝不能进 changelog**，否则 A 推 B、B 又推回来，无限回声
 *    冲突必须原样上报给调用方呈现，绝不静默覆盖
 *
 * 依赖注入（便于脱离 Electron 单测）：
 *   db      node:sqlite DatabaseSync 实例
 *   encrypt (string) -> { iv, data }      用本租户的 keyK 做 AES-256-GCM
 *   decrypt ({ iv, data }) -> string
 *   getAuth () -> { userId, uploadToken } | null
 *   cloudUrl 云端基址
 */

export const TBL_KIND = {
  products: 'product',
  inventory_batches: 'inventory_batch',
  transactions: 'transaction',
  stock_takes: 'stocktake',
  stock_take_items: 'stock_take_item',
  categories: 'category',
  units: 'unit',
  suppliers: 'supplier',
  customers: 'customer',
  payments: 'payment',
  expenses: 'expense',
  purchase_orders: 'purchase_order',
  purchase_order_items: 'purchase_order_item',
  price_tiers: 'price_tier',
  kits: 'kit',
  kit_items: 'kit_item',
  supplier_payments: 'supplier_payment',
  waste_logs: 'waste_log',
  payment_registers: 'payment_register',
}
export const KIND_TBL = Object.fromEntries(Object.entries(TBL_KIND).map(([t, k]) => [k, t]))

const PUSH_SEQ_KEY = 'sync_push_seq'
const PULL_CURSOR_KEY = 'sync_pull_cursor'

export function createCloudSync({ db, encrypt, decrypt, getAuth, cloudUrl, fetchImpl, log = () => {} }) {
  let colsCache = null
  let fkCache = null

  function ensureAux() {
    db.exec(
      'CREATE TABLE IF NOT EXISTS sync_pending_ref (\n' +
      '  child_tbl TEXT NOT NULL, child_guid TEXT NOT NULL, fk_col TEXT NOT NULL,\n' +
      '  parent_tbl TEXT NOT NULL, parent_guid TEXT NOT NULL,\n' +
      '  PRIMARY KEY (child_tbl, child_guid, fk_col)\n' +
      ')'
    )
    // 延后队列：父记录还没到就先存着，下次同步重试（避免 NOT NULL 外键插不进去导致整批失败）
    db.exec(
      'CREATE TABLE IF NOT EXISTS sync_pending_record (\n' +
      '  kind TEXT NOT NULL, id TEXT NOT NULL, updatedAt TEXT, iv TEXT, data TEXT,\n' +
      '  deleted INTEGER NOT NULL DEFAULT 0,\n' +
      '  PRIMARY KEY (kind, id)\n' +
      ')'
    )
  }

  function columnsOf(tbl) {
    if (!colsCache) colsCache = {}
    if (!colsCache[tbl]) colsCache[tbl] = db.prepare(`PRAGMA table_info("${tbl}")`).all().map((c) => c.name)
    return colsCache[tbl]
  }

  /** 每张表的外键：{ 本表列 -> 父表 }；由数据库自己声明，不靠人肉维护 */
  function fkOf(tbl) {
    if (!fkCache) fkCache = {}
    if (!fkCache[tbl]) {
      const rows = db.prepare(`PRAGMA foreign_key_list("${tbl}")`).all()
      const m = {}
      for (const r of rows) m[r.from] = r.table
      fkCache[tbl] = m
    }
    return fkCache[tbl]
  }

  /** 删除顺序用的依赖深度：父表深度小，子表深度大；删的时候从深往浅删 */
  function deleteOrder(tables) {
    const depth = {}
    const depthOf = (t, seen = new Set()) => {
      if (depth[t] !== undefined) return depth[t]
      if (seen.has(t)) return 0
      seen.add(t)
      let d = 0
      for (const p of Object.values(fkOf(t))) if (p !== t) d = Math.max(d, depthOf(p, seen) + 1)
      depth[t] = d
      return d
    }
    for (const t of tables) depthOf(t)
    return [...tables].sort((a, b) => (depth[b] || 0) - (depth[a] || 0))
  }

  function readNum(key, dflt = 0) {
    try {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
      const n = r ? Number(r.value) : NaN
      return Number.isFinite(n) ? n : dflt
    } catch { return dflt }
  }
  function writeNum(key, v) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(v))
  }

  /** 把一行组装成载荷：本地整数 id 不外传；外键转成父记录的 guid */
  function buildRecord(tbl, guid) {
    const row = db.prepare(`SELECT * FROM "${tbl}" WHERE guid = ?`).get(guid)
    if (!row) return null
    const fks = fkOf(tbl)
    const out = {}
    for (const c of columnsOf(tbl)) {
      if (c === 'id' || c === 'guid' || c === 'updated_at') continue
      if (fks[c]) continue // 外键列不传本地值
      out[c] = row[c]
    }
    const refs = {}
    for (const [col, parentTbl] of Object.entries(fks)) {
      const pid = row[col]
      if (pid === null || pid === undefined) continue
      const p = db.prepare(`SELECT guid FROM "${parentTbl}" WHERE id = ?`).get(pid)
      if (p && p.guid) refs[col] = p.guid
    }
    return { v: 1, tbl, row: out, refs }
  }

  /** 落一条远端记录：按 guid upsert；外键 guid 解析成本地 id，解析不到就挂"待回填" */
  function upsertRemote(tbl, guid, payload, updatedAt) {
    const cols = columnsOf(tbl)
    const fks = fkOf(tbl)
    const vals = {}
    for (const c of cols) {
      if (c === 'id') continue
      if (c === 'guid') { vals.guid = guid; continue }
      if (c === 'updated_at') { vals.updated_at = updatedAt || null; continue }
      if (fks[c]) continue
      if (payload.row && Object.prototype.hasOwnProperty.call(payload.row, c)) vals[c] = payload.row[c]
    }
    const pending = []
    for (const [col, parentTbl] of Object.entries(fks)) {
      const pguid = payload.refs ? payload.refs[col] : null
      if (!pguid) { vals[col] = null; continue }
      const p = db.prepare(`SELECT id FROM "${parentTbl}" WHERE guid = ?`).get(pguid)
      if (p) vals[col] = p.id
      else { vals[col] = null; pending.push([tbl, guid, col, parentTbl, pguid]) }
    }
    const existed = db.prepare(`SELECT id FROM "${tbl}" WHERE guid = ?`).get(guid)
    let localId
    if (existed) {
      const ks = Object.keys(vals)
      db.prepare(`UPDATE "${tbl}" SET ${ks.map((k) => `"${k}" = ?`).join(', ')} WHERE guid = ?`).run(...ks.map((k) => vals[k]), guid)
      localId = existed.id
    } else {
      const ks = Object.keys(vals)
      const info = db.prepare(`INSERT INTO "${tbl}" (${ks.map((k) => `"${k}"`).join(', ')}) VALUES (${ks.map(() => '?').join(', ')})`).run(...ks.map((k) => vals[k]))
      localId = info.lastInsertRowid
    }
    for (const p of pending) {
      db.prepare('INSERT OR REPLACE INTO sync_pending_ref (child_tbl, child_guid, fk_col, parent_tbl, parent_guid) VALUES (?,?,?,?,?)').run(...p)
    }
    // 父记录到了  把先前悬空的子记录补链
    const waited = db.prepare('SELECT * FROM sync_pending_ref WHERE parent_tbl = ? AND parent_guid = ?').all(tbl, guid)
    for (const w of waited) {
      db.prepare(`UPDATE "${w.child_tbl}" SET "${w.fk_col}" = ? WHERE guid = ?`).run(localId, w.child_guid)
      db.prepare('DELETE FROM sync_pending_ref WHERE child_tbl = ? AND child_guid = ? AND fk_col = ?').run(w.child_tbl, w.child_guid, w.fk_col)
    }
  }

  function queueDeferred(c) {
    db.prepare('INSERT OR REPLACE INTO sync_pending_record (kind, id, updatedAt, iv, data, deleted) VALUES (?,?,?,?,?,?)')
      .run(String(c.kind), String(c.id), c.updatedAt || '', c.iv || '', c.data || '', c.deleted ? 1 : 0)
  }

  /**
   * 应用一批远端变化。三条铁律：
   *  1) 应用过程本身会触发 CDC 触发器  先记 changelog 高水位，应用完把这段自产日志清掉（防回声）
   *  2) 单条失败（典型：父记录还没到、NOT NULL 外键插不进去）绝不能拖垮整批  丢进延后队列，下次重试
   *  3) 删除按依赖倒序（先子后父），避免被外键挡住
   */
  function applyChanges(changes) {
    ensureAux()
    const before = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_changelog').get().m
    const prev = db.prepare('SELECT kind, id, updatedAt, iv, data, deleted FROM sync_pending_record').all()
    const work = [...prev.map((x) => ({ ...x, deleted: !!x.deleted })), ...(changes || []).filter(Boolean)]
    if (!work.length) return { applied: 0, deferred: 0 }
    let applied = 0, deferred = 0
    db.exec('BEGIN')
    try {
      // 1) 删除：先子后父
      const dels = work.filter((c) => c && c.deleted && KIND_TBL[c.kind])
      for (const t of deleteOrder([...new Set(dels.map((c) => KIND_TBL[c.kind]))])) {
        for (const c of dels) {
          if (KIND_TBL[c.kind] !== t) continue
          try {
            db.prepare(`DELETE FROM "${t}" WHERE guid = ?`).run(String(c.id))
            db.prepare('DELETE FROM sync_pending_record WHERE kind = ? AND id = ?').run(String(c.kind), String(c.id))
            applied++
          } catch { queueDeferred(c); deferred++ }
        }
      }
      // 2) upsert：先父后子
      const ups = work.filter((c) => c && !c.deleted && KIND_TBL[c.kind])
      const order = deleteOrder([...new Set(ups.map((c) => KIND_TBL[c.kind]))]).reverse()
      for (const t of order) {
        for (const c of ups) {
          if (KIND_TBL[c.kind] !== t) continue
          try {
            const payload = JSON.parse(decrypt({ iv: c.iv, data: c.data }))
            if (!payload || !payload.tbl) continue
            upsertRemote(payload.tbl, String(c.id), payload, c.updatedAt)
            db.prepare('DELETE FROM sync_pending_record WHERE kind = ? AND id = ?').run(String(c.kind), String(c.id))
            applied++
          } catch (e) {
            queueDeferred(c); deferred++
            log(`[sync] 延后一条 ${c.kind}|${c.id}：${e.message}`)
          }
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
      throw e
    }
    const removed = db.prepare('DELETE FROM sync_changelog WHERE seq > ?').run(before).changes
    if (removed) log(`[sync] 丢弃应用过程自产日志 ${removed} 条（防回声）`)
    return { applied, deferred }
  }

  async function post(path, body) {
    const auth = getAuth()
    if (!auth || !auth.userId || !auth.uploadToken) throw new Error('未登录云账号')
    const f = fetchImpl || fetch
    const r = await f(cloudUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': auth.userId, 'x-token': auth.uploadToken },
      body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`)
    return j
  }

  /** 推：把 changelog 里未推的折叠后推上去 */
  async function push() {
    const from = readNum(PUSH_SEQ_KEY, 0)
    const rows = db.prepare('SELECT seq, tbl, guid, op, at FROM sync_changelog WHERE seq > ? ORDER BY seq LIMIT 500').all(from)
    if (!rows.length) return { pushed: 0, conflicts: [], changes: [] }
    const latest = new Map()
    for (const r of rows) latest.set(r.tbl + '|' + r.guid, r)
    const changes = []
    const mine = new Set()
    for (const r of latest.values()) {
      if (!TBL_KIND[r.tbl]) continue
      const rec = buildRecord(r.tbl, r.guid)
      if (!rec) changes.push({ kind: TBL_KIND[r.tbl], id: r.guid, updatedAt: r.at, deleted: true })
      else {
        const enc = encrypt(JSON.stringify(rec))
        changes.push({ kind: TBL_KIND[r.tbl], id: r.guid, updatedAt: r.at, iv: enc.iv, data: enc.data })
      }
      mine.add(TBL_KIND[r.tbl] + '|' + r.guid)
    }
    const resp = await post('/api/tenant/sync', { cursor: readNum(PULL_CURSOR_KEY, 0), changes })
    // 服务端会把刚推上去的也回传（seq 更大），那是回声，别当新数据应用
    const conflictKeys = new Set((resp.conflicts || []).map((c) => c.kind + '|' + c.id))
    const incoming = (resp.changes || []).filter((c) =>
      // 自己刚推上去的回声，别当新数据再应用一遍
      !(mine.has(c.kind + '|' + c.id) && !conflictKeys.has(c.kind + '|' + c.id)) &&
      // 冲突记录：绝不静默覆盖本地编辑，必须留给用户决定
      !conflictKeys.has(c.kind + '|' + c.id)
    )
    const ap = applyChanges(incoming)
    writeNum(PULL_CURSOR_KEY, Number(resp.cursor) || readNum(PULL_CURSOR_KEY, 0))
    const maxSeq = rows[rows.length - 1].seq
    writeNum(PUSH_SEQ_KEY, maxSeq)
    db.prepare('DELETE FROM sync_changelog WHERE seq <= ?').run(maxSeq)
    return { pushed: changes.length, conflicts: resp.conflicts || [], applied: ap.applied }
  }

  /** 拉：不动本地任何东西，只取远端变化落库 */
  async function pull() {
    const resp = await post('/api/tenant/sync', { cursor: readNum(PULL_CURSOR_KEY, 0), changes: [] })
    const ap = applyChanges(resp.changes || [])
    writeNum(PULL_CURSOR_KEY, Number(resp.cursor) || readNum(PULL_CURSOR_KEY, 0))
    return { pulled: (resp.changes || []).length, applied: ap.applied }
  }

  async function syncOnce() {
    const p = await push()
    const l = await pull()
    return { ...p, pulled: l.pulled }
  }

  function status() {
    const pending = (() => { try { return db.prepare('SELECT COUNT(*) n FROM sync_pending_ref').get().n } catch { return 0 } })()
    const backlog = (() => { try { return db.prepare('SELECT COUNT(*) n FROM sync_changelog WHERE seq > ?').get(readNum(PUSH_SEQ_KEY, 0)).n } catch { return 0 } })()
    const deferred = (() => { try { return db.prepare('SELECT COUNT(*) n FROM sync_pending_record').get().n } catch { return 0 } })()
    return { pushSeq: readNum(PUSH_SEQ_KEY, 0), pullCursor: readNum(PULL_CURSOR_KEY, 0), backlog, pendingRefs: pending, deferredRecords: deferred }
  }

  return { push, pull, syncOnce, status, applyChanges, buildRecord, TBL_KIND, KIND_TBL }
}
