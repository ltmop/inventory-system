// 豆包视觉模型独立测试脚本（不依赖 Electron）
// 用法：node scripts/test-doubao.mjs <图片路径> "<分析指令>"
// 示例：node scripts/test-doubao.mjs store-front.jpg "描述这张图片里的货架布局"

import fs from 'node:fs'
import path from 'node:path'

const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
const MODEL = 'doubao-seed-2-1-turbo-260628'
const API_KEY = '86c22f99-93dd-4ea6-b873-e29ba0176b64'

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

async function analyzeImage(imagePath, prompt) {
  if (!fs.existsSync(imagePath)) {
    console.error(`图片不存在: ${imagePath}`)
    process.exit(1)
  }

  const ext = path.extname(imagePath).toLowerCase()
  const mimeType = MIME_MAP[ext] ?? 'image/jpeg'
  const imgBuf = fs.readFileSync(imagePath)
  const imgB64 = imgBuf.toString('base64')

  const sizeMB = (imgBuf.length / 1024 / 1024).toFixed(1)
  console.log(`图片: ${imagePath} (${sizeMB}MB, ${mimeType})`)
  console.log(`指令: ${prompt}`)
  console.log('--- 分析中 ---')

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imgB64}` } },
          { type: 'text', text: prompt },
        ],
      }],
      max_tokens: 1500,
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error(`API 错误 ${res.status}: ${detail.slice(0, 300)}`)
    process.exit(1)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) {
    console.error('空响应:', JSON.stringify(data).slice(0, 300))
    process.exit(1)
  }

  console.log('--- 分析结果 ---')
  console.log(content)
  console.log('--- 完成 ---')
}

const imagePath = process.argv[2]
const prompt = process.argv[3] || '详细描述这张图片里的货架、商品品类和区域布局'

if (!imagePath) {
  console.log('用法: node scripts/test-doubao.mjs <图片路径> ["分析指令"]')
  process.exit(0)
}

analyzeImage(imagePath, prompt).catch((e) => {
  console.error('执行失败:', e.message)
  process.exit(1)
})
