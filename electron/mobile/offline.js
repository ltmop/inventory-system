// offline.js —— 手机端离线层（L1 读缓存 / L2 写队列 / L3 幂等重放）
// 铁律：本地只存「只读副本」与「传输暂存」，权威账永远在中心库。
// 重放结果由中心库裁决：被拒的单据进「需人工处理」，绝不静默丢弃、绝不在本地改账。
var Offline = (function () {
  var K_CACHE = 'fi-cache:'
  var K_QUEUE = 'fi-outbox'
  var K_IDMAP = 'fi-idmap'
  var CACHE_TTL = 7 * 24 * 3600 * 1000
  var MAX_QUEUE = 300
  var invoke = null, writeCh = {}, noQueue = {}, noCache = {}, onPending = null
  var flushing = false

  function readJSON(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch (e) { return d } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch (e) {} }
  function pad(n) { return n < 10 ? '0' + n : '' + n }
  function stamp(t) { var d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) }
  function tmpId() { return 'tmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }
  function isTmp(v) { return typeof v === 'string' && v.indexOf('tmp_') === 0 }

  // ---- 临时 id 映射：离线建档拿到的是 tmp_xxx，重放成功后换成服务端真 id，再改写队列里引用它的载荷 ----
  function mapId(t, real) { var m = readJSON(K_IDMAP, {}); m[t] = real; writeJSON(K_IDMAP, m) }
  function resolve(v, m) {
    if (isTmp(v)) return m[v] || null
    if (Array.isArray(v)) { var out = []; for (var i = 0; i < v.length; i++) { var r = resolve(v[i], m); if (r === null && isTmp(v[i])) return null; out.push(r) } return out }
    if (v && typeof v === 'object') {
      var o = {}
      for (var k in v) { if (!Object.prototype.hasOwnProperty.call(v, k)) continue; var r2 = resolve(v[k], m); if (r2 === null && isTmp(v[k])) return null; o[k] = r2 }
      return o
    }
    return v
  }

  // ---- L1 读缓存 ----
  function cacheKey(channel, payload) { return K_CACHE + channel + '|' + JSON.stringify(payload || {}) }
  function readable(channel) { return !writeCh[channel] && !noCache[channel] }
  function cachePut(channel, payload, data) { if (!readable(channel)) return; writeJSON(cacheKey(channel, payload), { at: Date.now(), data: data }) }
  function cacheGet(channel, payload) {
    var hit = readJSON(cacheKey(channel, payload), null)
    if (!hit || Date.now() - hit.at > CACHE_TTL) return null
    return hit
  }

  // ---- L2 写队列 ----
  function canQueue(channel) { return !!writeCh[channel] && !noQueue[channel] }
  function queue() { return readJSON(K_QUEUE, []) }
  function save(q) { writeJSON(K_QUEUE, q) }
  function pendingCount() { var q = queue(), n = 0; for (var i = 0; i < q.length; i++) if (!q[i].failed) n++; return n }
  function failedCount() { var q = queue(), n = 0; for (var i = 0; i < q.length; i++) if (q[i].failed) n++; return n }
  function queueWrite(channel, payload) {
    var q = queue()
    if (q.length >= MAX_QUEUE) throw new Error('离线单据太多（' + MAX_QUEUE + ' 笔），先连网重传再继续')
    var item = { id: 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), channel: channel, payload: payload, at: Date.now(), tries: 0, failed: false, err: '' }
    // 建档类通道离线时返回临时 id，调用方（建档→入库/开单）可以接着走
    if (channel === 'product:create' || channel === 'customer:create' || channel === 'supplier:create') { item.tmpId = tmpId(); item.payload = payload }
    q.push(item); save(q); notify()
    var res = { ok: true, offline: true, queued: true, clientDocId: item.id, at: item.at }
    if (item.tmpId) res.id = item.tmpId
    return res
  }

  // ---- L3 重放：按序、带原幂等键、由中心库裁决 ----
  function flush() {
    if (flushing || !invoke) return Promise.resolve({ done: 0, left: pendingCount() })
    if (!navigator.onLine) return Promise.resolve({ done: 0, left: pendingCount() })
    flushing = true
    var q = queue(), done = 0, m = readJSON(K_IDMAP, {})
    function step(i) {
      if (i >= q.length) return Promise.resolve()
      var it = q[i]
      if (it.failed) return step(i + 1)
      var p = resolve(it.payload, m)
      if (p === null) { it.err = '依赖的离线单据还没上传成功'; it.tries = it.tries + 1; save(q); return step(i + 1) }
      return invoke(it.channel, p).then(function (res) {
        if (res && res.ok === false) {
          // 中心库明确拒绝（如库存不足）：不删、不本地改账，挂起来等人处理
          it.failed = true; it.err = res.error || res.reason || '被中心库拒绝'; it.tries = it.tries + 1
          save(q) // 必须落盘：否则「需人工处理」状态丢失，下次 flush 又会重试
          return step(i + 1)
        }
        if (it.tmpId && res && res.id) { m[it.tmpId] = res.id; mapId(it.tmpId, res.id) }
        q.splice(i, 1); done++; save(q)
        return step(i)
      }, function (e) {
        // 网络还不通或服务端 5xx → 停下，保留队列，下次再试（幂等键保证不会重复记账）
        it.tries = it.tries + 1; it.err = e && e.message ? e.message : '网络未恢复'; save(q)
        return Promise.resolve()
      })
    }
    return step(0).then(function () { flushing = false; notify(); return { done: done, left: pendingCount() } }, function () { flushing = false; notify(); return { done: done, left: pendingCount() } })
  }

  function notify() { if (onPending) { try { onPending(pendingCount(), failedCount()) } catch (e) {} } }

  // ---- 待上传 / 需人工处理 面板 ----
  function openPanel() {
    var q = queue()
    var old = document.getElementById('offline-panel'); if (old) old.remove()
    var ov = document.createElement('div')
    ov.id = 'offline-panel'
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.96);z-index:350;padding:20px;color:#e6edf5;overflow:auto'
    var h = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">' +
      '<div style="font-size:20px;font-weight:800">离线单据（待核对）</div>' +
      '<button id="off-close" style="width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:20px">&#10005;</button></div>'
    if (q.length === 0) h += '<div style="color:#8fa3c0;padding:20px 0">没有待上传的单据，账已和中心库一致。</div>'
    for (var i = 0; i < q.length; i++) {
      var it = q[i]
      var color = it.failed ? '#f87171' : '#fbbf24'
      var tag = it.failed ? '需人工处理' : '待上传'
      h += '<div style="background:rgba(255,255,255,.07);border-radius:12px;padding:12px;margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between"><span style="font-weight:700">' + it.channel + '</span>' +
        '<span style="color:' + color + ';font-size:13px;font-weight:800">' + tag + '</span></div>' +
        '<div style="font-size:12px;color:#8fa3c0;margin-top:4px">' + stamp(it.at) + ' · 试过 ' + it.tries + ' 次' + (it.err ? ' · ' + it.err : '') + '</div>' +
        '<div style="font-size:12px;color:#c7d2e0;margin-top:6px;word-break:break-all">' + JSON.stringify(it.payload).slice(0, 160) + '</div>' +
        (it.failed ? '<button data-drop="' + it.id + '" style="margin-top:8px;height:36px;padding:0 14px;border-radius:9px;border:none;background:rgba(248,113,113,.25);color:#ffd9d9;font-weight:700">我已核对，删除这条</button>' : '') +
        '</div>'
    }
    h += '<button id="off-retry" style="width:100%;height:54px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:17px;font-weight:800;margin-top:6px">立即重传</button>'
    ov.innerHTML = h
    document.body.appendChild(ov)
    ov.querySelector('#off-close').onclick = function () { ov.remove() }
    ov.querySelector('#off-retry').onclick = function () {
      var b = ov.querySelector('#off-retry'); b.textContent = '重传中...'
      flush().then(function (r) {
        ov.remove()
        if (typeof toast === 'function') toast(r.done > 0 ? ('已上传 ' + r.done + ' 笔，剩 ' + r.left + ' 笔') : '还没连上，稍后再试')
      })
    }
    var drops = ov.querySelectorAll('[data-drop]')
    for (var d = 0; d < drops.length; d++) {
      drops[d].onclick = function () {
        var id = this.getAttribute('data-drop')
        var rest = queue().filter(function (x) { return x.id !== id })
        save(rest); notify(); ov.remove(); openPanel()
      }
    }
  }

  function init(cfg) {
    invoke = cfg.invoke
    writeCh = cfg.writeChannels || {}
    noQueue = cfg.noQueue || {}
    noCache = cfg.noCache || {}
    onPending = cfg.onPending
    if (pendingCount() || failedCount()) notify()
  }

  return {
    init: init, readable: readable, cacheGet: cacheGet, cachePut: cachePut,
    canQueue: canQueue, queueWrite: queueWrite, queue: queue, save: save,
    pendingCount: pendingCount, failedCount: failedCount, flush: flush,
    openPanel: openPanel, notify: notify, isTmp: isTmp,
  }
})()