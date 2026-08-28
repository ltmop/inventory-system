// 意见反馈（v3.0 全版本开放）：本地记录 feedback.log（始终）+ 可选 POST 到飞书 webhook
// 本地记录保证不依赖外部服务也能收集；webhook 配了才转发，没配只存本地
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let logFilePath = null
let feedbackLogPath = null
let appVersion = ''

export function initFeedback({ logFile, version, feedbackDir }) {
  logFilePath = logFile
  appVersion = version
  feedbackLogPath = feedbackDir ? path.join(feedbackDir, 'feedback.log') : null
}

/** 读 backup-error.log 末尾几行随反馈附上；文件不存在/读失败都静默返回 null */
function readLogTail(maxLines = 20) {
  try {
    if (!logFilePath || !fs.existsSync(logFilePath)) return null
    const text = fs.readFileSync(logFilePath, 'utf8').trim()
    if (!text) return null
    return text.split('\n').slice(-maxLines).join('\n')
  } catch {
    return null
  }
}

export async function sendFeedback(payload = {}) {
  const webhook = typeof payload.webhook === 'string' ? payload.webhook.trim() : ''
  const message = typeof payload.message === 'string' ? payload.message.trim() : ''
  const contact = typeof payload.contact === 'string' ? payload.contact.trim() : ''
  const category = typeof payload.category === 'string' ? payload.category.trim() : '其他'
  if (!message) return { ok: false, reason: '反馈内容为空' }

  const lines = [
    '【通用进销存·意见反馈】',
    `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `软件版本：v${appVersion}`,
    `分类：${category}`,
    `系统：Windows ${os.release()} (${os.arch()})`,
    contact ? `联系方式：${contact}` : null,
    '',
    message,
  ].filter((l) => l !== null)
  const logTail = readLogTail()
  if (logTail) lines.push('', '—— 最近错误日志 ——', logTail)
  const text = lines.join('\n')

  // 1) 始终本地记录（老板可在 dataDir/feedback.log 查看）
  if (feedbackLogPath) {
    try {
      fs.mkdirSync(path.dirname(feedbackLogPath), { recursive: true })
      fs.appendFileSync(feedbackLogPath, text + '\n' + '='.repeat(40) + '\n', 'utf8')
    } catch { /* 本地写不进不阻断 */ }
  }

  // 2) webhook 配了才转发，没配只存本地
  if (!/^https:\/\//.test(webhook)) {
    return { ok: true, note: '已保存到本地反馈记录' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const data = await res.json().catch(() => null)
    const code = data?.code ?? data?.StatusCode
    if (code != null && code !== 0) {
      return { ok: false, reason: data?.msg || data?.StatusMessage || '机器人拒收' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message || '网络错误' }
  } finally {
    clearTimeout(timer)
  }
}
