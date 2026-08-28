// 离线发码器：只生成不验签（验签逻辑在客户端 electron/license.js）
// 用法：node gen-license.js --machine A1B2C3 --level pro --expire 20261231
// 私钥文件：与脚本同目录下的 license-private.pem（绝不能随客户端分发）

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PRIVATE_KEY_FILE = path.join(__dirname, 'license-private.pem')

/** Ed25519 签名激活码内容 */
function sign(message) {
  const key = fs.readFileSync(PRIVATE_KEY_FILE, 'utf8')
  return crypto.sign(null, Buffer.from(message), key).toString('base64')
}

/** 生成激活码 */
function generate(machine, level, expireYYMMDD) {
  const fingerprint = machine.toUpperCase().slice(0, 6)
  const message = `ADU-FISH-${fingerprint}-${expireYYMMDD}-${level === 'max' ? 'M' : 'P'}`
  const sig = sign(message)
  return `${message}-${sig}`
}

// ---- CLI ----
function main() {
  const args = process.argv.slice(2)
  const getArg = (name) => {
    const idx = args.indexOf(name)
    return idx >= 0 ? args[idx + 1] : null
  }

  const machine = getArg('--machine')
  const level = getArg('--level') || 'pro'
  const expire = getArg('--expire')

  // 帮助
  if (!machine || !expire) {
    console.log('离线发码器 v3.0')
    console.log('用法：node gen-license.js --machine <机器ID前6位> --level <pro|max> --expire <YYMMDD>')
    console.log('示例：node gen-license.js --machine A1B2C3 --level pro --expire 261231')
    console.log('      → 生成进阶版激活码，有效期至 2026-12-31')
    console.log('      node gen-license.js --machine A1B2C3 --level max --expire 261231')
    console.log('      → 生成大师版激活码（无限 SKU/店/人）')
    console.log('')
    console.log('换机流程：')
    console.log('  1. 用户新电脑装软件 → 微信发你新机器 ID')
    console.log('  2. 你用新机器 ID 重新发码（同到期日）')
    console.log('  3. 用户在软件里输入新码激活')
    console.log('')
    if (!fs.existsSync(PRIVATE_KEY_FILE)) {
      console.log('⚠ 未找到私钥文件：', PRIVATE_KEY_FILE)
      console.log('  生成密钥对：openssl genpkey -algorithm ed25519 -out license-private.pem')
      console.log('  导出公钥：  openssl pkey -in license-private.pem -pubout')
      console.log('  公钥贴进 electron/license.js 的 PUBLIC_KEY_PEM 变量')
    }
    return
  }

  if (!fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error('❌ 私钥文件不存在：', PRIVATE_KEY_FILE)
    process.exit(1)
  }

  const code = generate(machine, level, expire)
  console.log('机器 ID：', machine.toUpperCase())
  console.log('到期日：', `20${expire.slice(0,2)}-${expire.slice(2,4)}-${expire.slice(4,6)}`)
  console.log('等级：  ', level === 'max' ? '大师版 ¥398/年' : level === 'pro' ? '进阶版 ¥168/年' : '免费版')
  console.log('')
  console.log('激活码：')
  console.log(code)
  console.log('')
  console.log('（复制上面这行发给用户即可）')
}

main()
