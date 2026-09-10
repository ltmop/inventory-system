// 首次登录恢复检测 + 空库上传保护 测试
// 场景：新电脑登录老账号 → 云端有备份、本机无流水 → 必须挂起上传并提示恢复，绝不允许空库覆盖云端
import { test, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 快照构建依赖完整库表结构，单测里只关心"发没发请求"，mock 掉
vi.mock('../electron/cloudSnapshot.js', () => ({
  buildSnapshot: () => ({ v: 1, storeName: 't', at: new Date().toISOString() }),
}))

let tmpDir
let cloud

// fetch mock：按 URL 路由到 fake 服务器
let server
function installFetchMock() {
  global.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url)
    if (u.endsWith('/api/device/bind')) {
      return jsonRes({ ok: true, userId: 'u1', username: 'testshop', uploadToken: 'ut', viewToken: 'vt', salt: 'somesalt' })
    }
    if (u.endsWith('/api/backup/list')) {
      return jsonRes({ ok: true, files: server.backups })
    }
    if (u.endsWith('/api/snapshot')) {
      server.snapshotUploads.push(JSON.parse(opts.body || '{}'))
      return jsonRes({ ok: true, at: new Date().toISOString() })
    }
    if (u.endsWith('/api/backup')) {
      server.backupUploads.push(1)
      return jsonRes({ ok: true })
    }
    throw new Error('unexpected url: ' + u)
  })
}
function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj }
}

async function freshCloud({ withTx = false, onboarded = false } = {}) {
  vi.resetModules()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-test-'))
  const dbPath = path.join(tmpDir, 'data.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE products (id INTEGER PRIMARY KEY); CREATE TABLE transactions (id INTEGER PRIMARY KEY); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  if (withTx) db.exec('INSERT INTO transactions (id) VALUES (1)')
  if (onboarded) db.exec("INSERT INTO settings (key, value) VALUES ('fi-onboarded', '1')")
  cloud = await import('../electron/cloud.js')
  cloud.initCloud(db, dbPath, tmpDir, tmpDir, () => true)
  return db
}

beforeEach(() => {
  server = { backups: [], snapshotUploads: [], backupUploads: [] }
  installFetchMock()
})

test('新电脑登录：云端有备份 + 本机无流水 → needsRestore，且不自动上传快照', async () => {
  server.backups = [{ date: '2026-09-06', size: 12345 }]
  await freshCloud({ withTx: false })
  const r = await cloud.loginAccount('testshop', 'password123', 'pc2')
  expect(r.ok).toBe(true)
  expect(r.needsRestore).toBe(true)
  expect(r.latestBackup.date).toBe('2026-09-06')
  // 挂起期间上传被拦
  await cloud.syncSnapshot()
  expect(server.snapshotUploads.length).toBe(0)
  expect(cloud.getCloudState().needsRestore).toBe(true)
})

test('新电脑登录：云端无备份 → 正常上传（真新店）', async () => {
  server.backups = []
  await freshCloud({ withTx: false })
  const r = await cloud.loginAccount('testshop', 'password123', 'pc2')
  expect(r.ok).toBe(true)
  expect(r.needsRestore).toBeUndefined()
  await new Promise((r2) => setTimeout(r2, 50))
  expect(server.snapshotUploads.length).toBe(1)
})

test('本机已完成新手引导：登录后正常上传，不弹恢复（老电脑重登）', async () => {
  server.backups = [{ date: '2026-09-06', size: 12345 }]
  await freshCloud({ withTx: true, onboarded: true })
  const r = await cloud.loginAccount('testshop', 'password123', 'pc1')
  expect(r.ok).toBe(true)
  expect(r.needsRestore).toBeUndefined()
  await new Promise((r2) => setTimeout(r2, 50))
  expect(server.snapshotUploads.length).toBe(1)
})

test('挂起状态持久化：重启（重新 initCloud）后仍然挂起', async () => {
  server.backups = [{ date: '2026-09-06', size: 12345 }]
  const db = await freshCloud({ withTx: false })
  await cloud.loginAccount('testshop', 'password123', 'pc2')
  expect(cloud.getCloudState().needsRestore).toBe(true)
  // 模拟重启：同目录重新 import + init
  vi.resetModules()
  const cloud2 = await import('../electron/cloud.js')
  cloud2.initCloud(db, path.join(tmpDir, 'data.db'), tmpDir, tmpDir, () => true)
  expect(cloud2.getCloudState().needsRestore).toBe(true)
  await cloud2.syncSnapshot()
  expect(server.snapshotUploads.length).toBe(0)
})

test('用户确认"我是新店"：dismiss 后恢复上传', async () => {
  server.backups = [{ date: '2026-09-06', size: 12345 }]
  await freshCloud({ withTx: false })
  await cloud.loginAccount('testshop', 'password123', 'pc2')
  expect(cloud.getCloudState().needsRestore).toBe(true)
  await cloud.dismissRestoreHold()
  expect(cloud.getCloudState().needsRestore).toBe(false)
  await new Promise((r2) => setTimeout(r2, 50))
  expect(server.snapshotUploads.length).toBe(1)
})

test('备份列表乱序时取最新日期', async () => {
  server.backups = [{ date: '2026-09-01', size: 1 }, { date: '2026-09-06', size: 2 }, { date: '2026-08-30', size: 3 }]
  await freshCloud({ withTx: false })
  const r = await cloud.loginAccount('testshop', 'password123', 'pc2')
  expect(r.latestBackup.date).toBe('2026-09-06')
})
