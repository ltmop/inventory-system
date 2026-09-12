// probe-kws-rate.mjs —— 测量 TTS→KWS 的**单次检出率 p**，用于给那条 flaky 断言定合适的重试次数。
//
// 背景：test-backend.mjs 里 `TTS 合成语音能被 KWS 检出（5 次内）` 实测约 1/3 概率失败。
// 若 5 次全失败概率 = 1/3，则单次检出率 p ≈ 0.2 —— 但那只是反推，必须实测。
// 这个探针不参与门槛，只是诊断工具。
//
// 跑法（仓库根目录）：node scripts/probe-kws-rate.mjs [次数，默认 30]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as tts from '../electron/tts.js'
import * as kws from '../electron/kws.js'
import { checkKwsModel, ensureKwsModel, KWS_MODEL_NAME } from '../electron/kwsModelManager.js'
import { checkTtsModel, TTS_MODEL_NAME } from '../electron/ttsModelManager.js'

const N = Number(process.argv[2] || 30)
const appdataModels = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'fishing-inventory',
  'models',
)
const resolveModelDir = (name) => {
  const spikeDir = path.resolve('spike/models', name)
  return fs.existsSync(spikeDir) ? spikeDir : path.join(appdataModels, name)
}
const spikeTtsDir = resolveModelDir(TTS_MODEL_NAME)
const spikeKwsDir = resolveModelDir(KWS_MODEL_NAME)

console.log('TTS 模型: ' + spikeTtsDir + '   ready=' + checkTtsModel(spikeTtsDir).ready)
console.log('KWS 模型: ' + spikeKwsDir + '   ready=' + checkKwsModel(spikeKwsDir).ready)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kws-probe-'))
const kwsTestDir = path.join(tmp, 'kws-model')
fs.cpSync(spikeKwsDir, kwsTestDir, { recursive: true })
const em = await ensureKwsModel(kwsTestDir)
console.log('ensureKwsModel: ' + JSON.stringify(em))
kws.initKws(kwsTestDir)
console.log('preloadSpotter: ' + JSON.stringify(kws.preloadSpotter()))

// 与 test-backend.mjs L735-743 完全一致：16kHz、0.25s 小块推送、检测到即返回
const feedWav16k = (pcm) => {
  kws.resetKws()
  for (let off = 0; off < pcm.length; off += 4000) {
    const r = kws.pushPcm({ pcm: pcm.subarray(off, Math.min(off + 4000, pcm.length)) })
    if (!r.ok) throw new Error('KWS 推送失败：' + r.reason)
    if (r.detected) return r.detected
  }
  return null
}
// 与 test-backend.mjs L761-773 完全一致的重采样（线性插值 + 前后各 0.3s 静音）
const ttsWavToPcm16 = (w) => {
  const n = (w.wav.length - 44) / 2
  const src = new Float32Array(n)
  for (let i = 0; i < n; i++) src[i] = w.wav.readInt16LE(44 + i * 2) / 32768
  const outLen = Math.round((n * 16000) / w.sampleRate)
  const pcm = new Float32Array(outLen + 9600)
  for (let i = 0; i < outLen; i++) {
    const pos = (i * (n - 1)) / (outLen - 1)
    const lo = Math.floor(pos)
    pcm[4800 + i] = src[lo] * (1 - pos + lo) + src[Math.min(lo + 1, n - 1)] * (pos - lo)
  }
  return pcm
}

tts.initTts(spikeTtsDir)

let hit = 0
let synthFail = 0
let firstWav = null
const hitIdx = []
for (let i = 0; i < N; i++) {
  const w = tts.synthesize({ text: '小杜小杜' })
  if (!w.ok) { synthFail++; continue }
  const pcm = ttsWavToPcm16(w)
  if (!firstWav) firstWav = pcm
  if (feedWav16k(pcm) === '小杜小杜') { hit++; hitIdx.push(i + 1) }
}

const okN = N - synthFail
const p = okN ? hit / okN : 0

console.log('')
console.log('合成次数      : ' + N + '（合成失败 ' + synthFail + '）')
console.log('检出命中      : ' + hit + '/' + okN)
console.log('单次检出率 p  : ' + p.toFixed(3))
// 命中位置分布：套件里实测「5 次里 4 次第 1 次就命中」，与 p=0.267 严重不符（该概率约 2%）。
// 若命中集中在**开头**，说明 TTS 引擎有状态效应（前几次的合成质量更好），而不是独立同分布。
console.log('命中位置      : ' + (hitIdx.length ? hitIdx.join(',') : '（无）'))
const first5 = hitIdx.filter((x) => x <= 5).length
if (okN >= 10) {
  const firstHalf = hitIdx.filter((x) => x <= Math.floor(okN / 2)).length
  const secondHalf = hit - firstHalf
  console.log('前 ' + Math.floor(okN / 2) + ' 次命中 ' + firstHalf + '，后 ' + (okN - Math.floor(okN / 2)) + ' 次命中 ' + secondHalf
    + (firstHalf > secondHalf * 2 ? '  → **明显集中在前半**，不是独立同分布！' : '  → 分布看不出明显前后差异'))
  console.log('前 5 次内命中  : ' + first5 + '/5')
}

// 决定性实验：先找一段「能命中」的合成音频，再拿**同一段音频连喂 20 次**。
// 一次实验同时回答两个问题：
//   (a) KWS 对同一输入是否确定性 —— 若 20 次结果不一致，就说明随机性不只在合成侧；
//   (b) 命中率是否随连喂次数衰减 —— 若后 10 次明显少于前 10 次，说明 resetKws/spotter.reset
//       没有彻底清掉内部状态（那就不只是测试问题，生产里唤醒词用久了也可能失灵）。
// 上一版只喂 3 次就下结论「KWS 确定性」，两次运行结论还互相矛盾 —— 样本太小，不作数。
let probeWav = null
for (let i = 0; i < 12 && !probeWav; i++) {
  const w = tts.synthesize({ text: '小杜小杜' })
  if (w.ok) {
    const pcm = ttsWavToPcm16(w)
    if (feedWav16k(pcm) === '小杜小杜') probeWav = pcm
  }
}
if (probeWav) {
  const reps = []
  for (let i = 0; i < 20; i++) reps.push(feedWav16k(probeWav) === '小杜小杜' ? 1 : 0)
  const h = reps.reduce((a, b) => a + b, 0)
  const first10 = reps.slice(0, 10).reduce((a, b) => a + b, 0)
  const last10 = reps.slice(10).reduce((a, b) => a + b, 0)
  console.log('')
  console.log('决定性实验：同一段「能命中」音频连喂 20 次')
  console.log('  命中        : ' + h + '/20')
  console.log('  逐次模式    : ' + reps.join(''))
  console.log('  前10 / 后10 : ' + first10 + ' / ' + last10
    + (h > 0 && h < 20 ? '   → **同一输入结果不一致：KWS 侧也不确定**' : '   → 该样本对 KWS 是确定的'))
  console.log('  衰减判断    : ' + (last10 < first10 ? '**有衰减迹象**（reset 可能未彻底清状态）' : '无衰减迹象'))
} else {
  console.log('')
  console.log('决定性实验：12 次合成里没找到能命中的样本，跳过（说明当前检出率极低）')
}

if (p > 0 && p < 1) {
  console.log('')
  console.log('按实测 p 推算「n 次全失败」的概率：')
  for (const n of [5, 9, 13, 17, 21, 25, 31, 41]) {
    const tag = n === 5 ? '   <- 现行断言用的 5 次' : ''
    console.log('  n=' + String(n).padStart(2) + ' → ' + Math.pow(1 - p, n).toExponential(3) + tag)
  }
  console.log('期望合成次数  : ' + (1 / p).toFixed(1) + '（因为检测到就提前退出，典型成本≈这个，不随 n 线性增长）')
}

// 顺带测**不同说话人 sid** 的检出率。
// 若某个 sid 的合成音 KWS 能稳定检出（p≈1），就把断言改成固定用那个 sid ——
// 那样这条测试就从「概率性、需要重试」变成**确定性、一次即中**，这才是根治。
const SID_TRIES = Number(process.argv[3] || 8)
console.log('')
console.log('不同说话人（sid）的检出率（各 ' + SID_TRIES + ' 次）：')
const sidRates = []
for (const sid of [0, 1, 2, 3, 4, 5]) {
  let h = 0
  let f = 0
  for (let i = 0; i < SID_TRIES; i++) {
    const w = tts.synthesize({ text: '小杜小杜', sid })
    if (!w.ok) { f++; continue }
    if (feedWav16k(ttsWavToPcm16(w)) === '小杜小杜') h++
  }
  const denom = SID_TRIES - f
  const rate = denom ? h / denom : 0
  sidRates.push({ sid, h, denom, rate })
  console.log('  sid=' + sid + ' → ' + h + '/' + denom + (f ? '（合成失败 ' + f + '）' : '') + '  p=' + rate.toFixed(2))
}
const best = sidRates.filter((x) => x.denom > 0).sort((a, b) => b.rate - a.rate)[0]
if (best && best.rate === 1) {
  console.log('  ✅ sid=' + best.sid + ' 全部命中 → 可以把断言改成固定用 sid=' + best.sid + '，测试变成确定性')
} else if (best) {
  console.log('  ⚠️ 没有哪个 sid 达到 100%；最高是 sid=' + best.sid + ' p=' + best.rate.toFixed(2))
}

fs.rmSync(tmp, { recursive: true, force: true })
