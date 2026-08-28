import fs from 'node:fs'

// 1. Clean main.js
let main = fs.readFileSync('electron/main.js', 'utf8')

// Remove voice/tts/kws/model imports
const importsToRemove = [
  "import * as voice from './voice.js'\n",
  "import * as tts from './tts.js'\n",
  "import * as kws from './kws.js'\n",
  "import { MODEL_NAME, ensureModel } from './modelManager.js'\n",
  "import { TTS_MODEL_NAME, ensureTtsModel } from './ttsModelManager.js'\n",
  "import { KWS_MODEL_NAME, ensureKwsModel } from './kwsModelManager.js'\n",
]
for (const imp of importsToRemove) {
  main = main.replace(imp, '')
}

// Remove ai.transcribe line
main = main.replace(
  /\/\/ 离线语音识别模型目录.*?\n\s*.*?voiceModelDir.*?\n[\s\S]*?let kwsDownloading = null\n/,
  ''
)

// Remove registerModelDownload function
main = main.replace(
  /\/\*\* 注册"模型下载.*?\n\s*function registerModelDownload[\s\S]*?\n\s*\}\n/,
  ''
)

// Remove voice/tts/kws IPC block (from "离线语音识别" comment to the closing brace of kws registerModelDownload)
main = main.replace(
  /\/\/ 离线语音识别[\s\S]*?\/\/ KWS 引擎等渲染端开启监听后首次推送时懒加载[\s\S]*?\n\s*\}\)\n/,
  ''
)

// Remove specific single-line handlers
main = main.replace("  handle('ai:parseInboundNote', (d, p) => ai.parseInboundNote(p))\n", '')
main = main.replace("  handle('ai:transcribe', (d, p) => ai.transcribeAudio(p))\n", '')
main = main.replace("  handle('ai:insights', (d, p) => ai.aiInsights(p.limit ?? 50))\n", '')

// Remove microphone permission handler
main = main.replace(
  /\/\/ 麦克风权限[\s\S]*?\n\s*\}\)\n/,
  ''
)

// Clean triple+ blank lines
main = main.replace(/\n{3,}/g, '\n\n')
fs.writeFileSync('electron/main.js', main)
console.log('main.js cleaned')

// 2. Clean preload.cjs
let preload = fs.readFileSync('electron/preload.cjs', 'utf8')
const channelsToRemove = [
  "'voice:status',\n",
  "'voice:transcribe',\n",
  "'voice:download',\n",
  "'tts:status',\n",
  "'tts:speak',\n",
  "'tts:download',\n",
  "'kws:status',\n",
  "'kws:download',\n",
  "'kws:push',\n",
  "'kws:reset',\n",
  "'ai:transcribe',\n",
  "'ai:parseInboundNote',\n",
]
for (const ch of channelsToRemove) {
  preload = preload.replace(ch, '')
}

// Remove onVoiceProgress, onTtsProgress, onKwsProgress methods
preload = preload.replace(
  /,\n\s*\/\/ 订阅模型下载进度[\s\S]*?\n\s*\}\)\n/,
  ''
)

// Also remove the progress subscription methods if they exist separately
preload = preload.replace(
  /\n\s*onVoiceProgress[\s\S]*?onKwsProgress[\s\S]*?\n\s*\},?\n/,
  '\n'
)

// Fix any leftover progress methods in the expose object
preload = preload.replace(/,\n\s*onVoiceProgress\(callback\)[\s\S]*?\n\s*\}/, '')
preload = preload.replace(/,\n\s*onTtsProgress\(callback\)[\s\S]*?\n\s*\}/, '')
preload = preload.replace(/,\n\s*onKwsProgress\(callback\)[\s\S]*?\n\s*\}/, '')

preload = preload.replace(/\n{3,}/g, '\n\n')
fs.writeFileSync('electron/preload.cjs', preload)
console.log('preload.cjs cleaned')

// 3. Clean App.tsx
let app = fs.readFileSync('src/App.tsx', 'utf8')
app = app.replace("import { readWakeEnabled, startWakeListener } from '@/lib/wakeWord'\n", '')
app = app.replace("import { AiPanel } from '@/components/ai/AiPanel'\n", '')
app = app.replace(
  /\/\/ 唤醒词监听[\s\S]*?\n\s*\}\n\s*\}, \[\]\)/,
  ''
)
app = app.replace(/\n{3,}/g, '\n\n')
fs.writeFileSync('src/App.tsx', app)
console.log('App.tsx cleaned')

// 4. Clean SettingsPage.tsx - remove voice/tts/kws sections
let settings = fs.readFileSync('src/pages/SettingsPage.tsx', 'utf8')
// Remove voice model section - look for VoiceModelSection or relevant imports
settings = settings.replace(/import.*VoiceModelSection.*\n/g, '')
settings = settings.replace(/import.*TtsModelSection.*\n/g, '')
settings = settings.replace(/import.*KwsModelSection.*\n/g, '')
settings = settings.replace(/import.*useModelDownload.*\n/g, '')

// Remove the actual component usage sections if they're rendered
// We'll handle this more carefully - just remove import lines for now
fs.writeFileSync('src/pages/SettingsPage.tsx', settings)
console.log('SettingsPage.tsx cleaned (imports)')

console.log('\nAll cleanup done.')
