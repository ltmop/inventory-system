// AES-256-GCM 加解密：纯 node:crypto，可单测
// 密钥 K 在首次配对时生成，永不上传服务器，只存本地 cloud.json
// 手机端通过 URL #key=K 持有同一密钥，WebCrypto 本地解密

import crypto from 'node:crypto'

/** 生成 256-bit AES 密钥，base64url 编码 */
export function generateKey() {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * 用账户密码 + 服务器盐派生 256-bit 密钥（PBKDF2-SHA256）。
 * 所有设备用同一账户密码登录 → 得到同一密钥 → 都能解密云端数据（多设备共享的关键）。
 * 密钥本身永不上传服务器，服务器只存盐（盐不是密钥，泄露无害）。
 */
export function deriveKey(password, saltHex) {
  const salt = Buffer.from(String(saltHex), 'hex')
  const derived = crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256')
  return derived.toString('base64url')
}

/** AES-256-GCM 加密：plaintext(string) → { iv(base64url), data(base64url) } */
export function encrypt(plaintext, keyB64) {
  const key = Buffer.from(keyB64, 'base64url')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // iv + authTag + ciphertext
  const payload = Buffer.concat([iv, authTag, encrypted])
  return {
    iv: iv.toString('base64url'),
    data: payload.toString('base64url'),
  }
}

/** AES-256-GCM 解密：{ iv(base64url), data(base64url) } → plaintext(string) */
export function decrypt(encrypted, keyB64) {
  const key = Buffer.from(keyB64, 'base64url')
  const payload = Buffer.from(encrypted.data, 'base64url')
  const iv = payload.subarray(0, 12)
  const authTag = payload.subarray(12, 28)
  const ciphertext = payload.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}

/** 加密大 Buffer（备份用）：Buffer → { iv, data } */
export function encryptBuffer(buf, keyB64) {
  const key = Buffer.from(keyB64, 'base64url')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(buf), cipher.final()])
  const authTag = cipher.getAuthTag()
  const payload = Buffer.concat([iv, authTag, encrypted])
  return {
    iv: iv.toString('base64url'),
    data: payload.toString('base64url'),
  }
}

/** 解密大 Buffer：{ iv, data } → Buffer */
export function decryptBuffer(encrypted, keyB64) {
  const key = Buffer.from(keyB64, 'base64url')
  const payload = Buffer.from(encrypted.data, 'base64url')
  const iv = payload.subarray(0, 12)
  const authTag = payload.subarray(12, 28)
  const ciphertext = payload.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
