// 每天定时把「今天该做的事」推给老板。
//
// 老板 2026-09-21：「软件通知这个问题，要自动」。
//
// 为什么走机器人 webhook、而不是 APP 推送：
//   · 微信/飞书他一定会看；APP 推送他有很大概率整屏划掉；
//   · 这条路**不用重装 APK**，今天就能上；
//   · 服务器本来就有 crontab（备份任务已经在跑），加一条很自然。
// 长远的正解是 APP 本地通知（要加原生插件、重打 APK），那是产品化阶段的事。
//
// 配置：/opt/inventory-app/data/notify.json
//   { "enabled": true, "webhook": "https://...", "hour": 7 }
// 支持 企业微信群机器人 / 飞书自定义机器人 / 通用 webhook（按 URL 自动选消息格式）。
//
// 用法：node --experimental-sqlite daily-todo-push.mjs [--dry]   （--dry 只打印不发送）
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase } from './electron/db.js'
// 口径层唯一入口（红线：不许绕开 commandsLive 直接 import commands/*）
import { commands as cmds } from './electron/commandsLive.js'

const APP = '/opt/inventory-app'
const DATA = path.join(APP, 'data')
const CFG = path.join(DATA, 'notify.json')
const DRY = process.argv.includes('--dry')

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')) } catch { return {} }
}

/** 按 URL 判断是哪家的机器人，生成对应的 payload */
function buildPayload(webhook, text) {
  if (/qyapi\.weixin\.qq\.com/.test(webhook)) {
    return { msgtype: 'text', text: { content: text } }          // 企业微信群机器人
  }
  if (/open\.feishu\.cn|larksuite/.test(webhook)) {
    return { msg_type: 'text', content: { text: text } }          // 飞书自定义机器人
  }
  if (/dingtalk/.test(webhook)) {
    return { msgtype: 'text', text: { content: text } }           // 钉钉机器人
  }
  return { text: text }                                            // 通用（Server酱类另有格式，按需扩展）
}

function format(todo) {
  const L = []
  L.push('【今天该做的事】' + todo.date)
  L.push('')
  if (todo.restock.length) {
    L.push('📦 该补货（共 ' + todo.counts.restockTotal + ' 样低于预警线，最缺的 ' + todo.restock.length + ' 样）')
    todo.restock.forEach((r) => L.push('  · ' + r.name + '　剩 ' + r.stock + '（预警 ' + r.threshold + '）'))
    L.push('')
  }
  if (todo.collect.length) {
    L.push('💰 该催款（' + todo.collect.length + ' 位）')
    todo.collect.forEach((c) => L.push('  · ' + c.name + '　欠 ¥' + (c.outstanding / 100).toFixed(2) + (c.phone ? '　' + c.phone : '')))
    L.push('')
  }
  if (todo.anomalies.length) {
    L.push('⚠️ 对不上的地方')
    todo.anomalies.forEach((a) => L.push('  · ' + a.text))
    L.push('')
  }
  if (!todo.restock.length && !todo.collect.length && !todo.anomalies.length) {
    L.push('今天没有要处理的事，安心做生意。')
  }
  return L.join('\n')
}

async function main() {
  const cfg = loadCfg()
  if (!cfg.enabled) { console.log('[todo-push] 未启用（notify.json 里 enabled=false 或文件不存在），跳过'); return }
  const webhook = String(cfg.webhook || '').trim()
  if (!/^https:\/\//.test(webhook)) { console.log('[todo-push] webhook 没配或不是 https，跳过'); return }

  const db = openDatabase(path.join(DATA, 'data.db'))
  const todo = cmds.dailyTodo(db)
  const text = format(todo)
  if (DRY) { console.log(text); return }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPayload(webhook, text)),
    signal: AbortSignal.timeout(15000),
  })
  const body = await res.text().catch(() => '')
  console.log('[todo-push] ' + (res.ok ? '已推送' : '推送失败 http-' + res.status) + ' ' + body.slice(0, 120))
  if (!res.ok) process.exitCode = 1
}

main().catch((e) => { console.error('[todo-push] 出错: ' + e.message); process.exitCode = 1 })
