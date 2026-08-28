// 自签名证书生成：让局域网手机端走 HTTPS，浏览器才给麦克风/摄像头权限（语音识别必需）
// 证书存 %APPDATA%/fishing-inventory/ssl/，首次生成，之后复用。
// 用系统 openssl 生成（Git 自带），纯代码无原生依赖。失败返回 { ok:false }，调用方退回纯 HTTP。
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * 确保自签名证书就位（cert.pem + key.pem）
 * @param {string} dataDir 数据目录
 * @param {string} lanIp 当前局域网 IP（写进证书 SAN，让手机浏览器少报一项错）
 * @returns {{ ok: true, cert: string, key: string } | { ok: false, reason: string }}
 */
export function ensureTlsCert(dataDir, lanIp) {
  const sslDir = path.join(dataDir, 'ssl')
  const cert = path.join(sslDir, 'cert.pem')
  const key = path.join(sslDir, 'key.pem')
  // 已生成过直接复用
  if (fs.existsSync(cert) && fs.existsSync(key)) {
    return { ok: true, cert, key }
  }
  try {
    fs.mkdirSync(sslDir, { recursive: true })
    const ip = lanIp || '127.0.0.1'
    // 自签名证书有效期 10 年；SAN 带上局域网 IP，让手机浏览器少一个"证书与域名不匹配"的错
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${key}" -out "${cert}" -days 3650 -nodes ` +
        `-subj "/CN=fishing-inventory" ` +
        `-addext "subjectAltName=IP:${ip},DNS:localhost"`,
      { stdio: 'ignore', windowsHide: true },
    )
    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
      return { ok: false, reason: '证书文件未生成' }
    }
    return { ok: true, cert, key }
  } catch (e) {
    // 生成失败（openssl 不可用等）退回纯 HTTP，不阻断手机看店
    return { ok: false, reason: e?.message ?? String(e) }
  }
}
