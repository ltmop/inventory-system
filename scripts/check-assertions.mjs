// check-assertions.mjs —— 把「断言只加不减」变成机器可校验的闸门
//
// 【为什么不能只写死一个 611】
// scripts/test-backend.mjs 里有 **5 处条件跳过**，全部依赖本地语音模型（spike/ 与 %APPDATA%，
// 而 .gitignore 第 4 行就是 spike/ —— 模型故意不入 git）：
//   L559 跳过 ASR 模型就绪校验      L618 跳过 ASR 真实转写
//   L688 跳过 TTS 真实合成          L757 跳过 KWS 夹具检出
//   L789 跳过 KWS 真实检出
// 实测：本机（模型齐全）= 611 项；git archive 纯净检出（无模型）= 607 项，差的就是这 4 条。
// 所以「≥611」在一个干净检出上永远不可能满足 —— 门槛必须**按环境档位**分别记。
//
// 【档位怎么判】不猜路径，直接用**套件自己打印的跳过标记**：出现了哪些标记 = 哪个档位。
// 这样档位定义永远不会和套件漂移。
//
// 【怎么用】
//   node scripts/check-assertions.mjs              # 机器闸门：跑套件并校验，不符则 exit 1
//   node scripts/check-assertions.mjs --update     # 记录当前档位的基线（下降需 --force-drop）
//   node scripts/check-assertions.mjs --force-drop # 确认「有意减少断言」并下调基线
//
// 退出码：0 = 通过；1 = 断言数低于基线或套件失败；2 = 环境未记录 / 用法错误

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = process.env.FI_REPO || path.resolve(HERE, '..')
const BASELINE_FILE = path.join(HERE, 'assertion-baseline.json')
const SUITE = path.join(HERE, 'test-backend.mjs')

// 套件里 5 处条件跳过的原文标记（改动套件里这些文案时，这里要同步）
const ALL_MARKERS = [
  '跳过 ASR 模型就绪校验',
  '跳过 ASR 真实转写',
  '跳过 TTS 真实合成',
  '跳过 KWS 夹具检出',
  '跳过 KWS 真实检出',
]

// 已知偶发失败（flake）——**不是本次改动引入**，实测复现率约 1/3（2026-09-12 连跑 3 次失败 1 次；
// 更早也曾 4 次里失败 1 次）。它是 sherpa-onnx 合成语音→KWS 回环检出，本质是概率性识别，不是回归。
// 门槛不能因为它误报就变松，但必须把它和真回归区分开，否则人会对门槛失去信任。
const KNOWN_FLAKY = [
  'TTS 合成语音能被 KWS 检出（5 次内）',
]

const argv = process.argv.slice(2)
const UPDATE = argv.includes('--update')
const FORCE_DROP = argv.includes('--force-drop')

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return { note: '断言只加不减的机器闸门', tiers: [] }
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) } catch (e) {
    console.error('✗ ' + BASELINE_FILE + ' 不是合法 JSON：' + e.message)
    process.exit(2)
  }
}
function saveBaseline(b) { fs.writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 2) + '\n') }

function tierKey(markers) { return markers.length === 0 ? 'with-models' : (markers.length === ALL_MARKERS.length ? 'no-models' : 'partial:' + markers.map((m) => m.replace(/^跳过 /, '')).join('+')) }
function sameSet(a, b) { return a.length === b.length && a.every((x) => b.includes(x)) }

function gitHead() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' })
  return r.status === 0 ? String(r.stdout).trim() : 'unknown'
}
function gitDirty() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
  return r.status === 0 ? String(r.stdout).trim().length > 0 : null
}

// ---------- 跑套件 ----------
if (!fs.existsSync(SUITE)) { console.error('✗ 找不到 ' + SUITE); process.exit(2) }
console.log('跑 ' + path.relative(REPO, SUITE) + ' …')
const run = spawnSync(process.execPath, [SUITE], { cwd: REPO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
if (run.error) {
  console.error('✗ 无法启动测试套件：' + run.error.message)
  console.error('  （若报 EPERM/管道错误，请在普通终端里手动跑 node scripts/test-backend.mjs）')
  process.exit(2)
}
const out = String(run.stdout || '') + String(run.stderr || '')

// ---------- 判定环境档位（用套件自己的跳过标记） ----------
const seen = ALL_MARKERS.filter((m) => out.includes(m))
const key = tierKey(seen)

// ---------- 解析结果 ----------
const passM = out.match(/全部\s*(\d+)\s*项断言通过/)
const failM = out.match(/✗\s*(\d+)\s*项失败/)

console.log('环境档位    : ' + key + (seen.length ? '（跳过 ' + seen.length + ' 处：' + seen.join('、') + '）' : '（模型齐全，无跳过）'))

if (run.status !== 0 || !passM) {
  console.error('')
  console.error('✗ 测试套件未正常通过（exit=' + run.status + '）')
  if (failM) console.error('  报告失败断言数：' + failM[1])
  if (!passM) console.error('  没有找到「全部 N 项断言通过」汇总行 —— 套件可能中途崩了，这本身就是失败。')
  console.error('  最后 20 行输出：')
  for (const line of out.split('\n').slice(-20)) console.error('    ' + line)
  const flaky = KNOWN_FLAKY.filter((f) => out.includes('✗ ' + f))
  if (flaky.length) {
    console.error('')
    console.error('⚠️ 命中已知 flake（实测约 1/3 概率偶发，**非本次改动引入**）：')
    for (const f of flaky) console.error('    ' + f)
    console.error('  处理建议：先重跑一次确认。若连续复现，请修这条断言本身（或提高重试次数），')
    console.error('            不要靠"多跑几次碰运气"蒙过去 —— 那会让整条门槛失去可信度。')
  }
  process.exit(1)
}
const n = Number(passM[1])
console.log('实测断言数  : ' + n)

// ---------- 比对基线 ----------
const base = loadBaseline()
base.tiers = base.tiers || []
const entry = base.tiers.find((t) => t.key === key || sameSet(t.skipMarkers || [], seen))

if (UPDATE) {
  const head = gitHead()
  const dirty = gitDirty()
  if (entry) {
    if (n < entry.floor && !FORCE_DROP) {
      console.error('')
      console.error('✗ 拒绝下调：' + key + ' 的基线是 ' + entry.floor + '，实测只有 ' + n + '（少了 ' + (entry.floor - n) + ' 项）。')
      console.error('  断言只加不减是铁律。若确属有意删除，请加 --force-drop 并在提交信息里写明删了哪几条、为什么。')
      process.exit(1)
    }
    const old = entry.floor
    entry.floor = n
    entry.updatedAt = new Date().toISOString()
    entry.commit = head
    entry.worktreeDirty = dirty
    saveBaseline(base)
    console.log((n < old ? '↓ 已下调' : n > old ? '↑ 已上调' : '= 无变化') + '：' + key + ' 基线 ' + old + ' → ' + n + '（HEAD ' + head + (dirty ? '，工作树有未提交改动' : '，工作树干净') + '）')
    if (dirty) console.log('  ⚠️ 工作树不干净 —— 这个数字含未提交内容；建议提交后再跑一次 --update 让基线对齐提交版。')
    process.exit(0)
  }
  base.tiers.push({
    key,
    skipMarkers: seen,
    floor: n,
    note: seen.length === 0 ? '本机语音模型齐全' : (seen.length === ALL_MARKERS.length ? '无语音模型（纯净检出 / CI）' : '部分模型'),
    commit: gitHead(),
    worktreeDirty: gitDirty(),
    updatedAt: new Date().toISOString(),
  })
  saveBaseline(base)
  console.log('+ 新记录档位：' + key + ' 基线 = ' + n)
  process.exit(0)
}

if (!entry) {
  console.error('')
  console.error('✗ 这个环境档位还没记录过：' + key)
  console.error('  出现的跳过项：' + (seen.length ? seen.join('、') : '（无）'))
  console.error('  已记录的档位：' + (base.tiers.length ? base.tiers.map((t) => t.key + '(' + t.floor + ')').join('、') : '（无）'))
  console.error('  这是新环境组合，闸门无法判断该拿哪个数字比。请跑一次：')
  console.error('    node scripts/check-assertions.mjs --update')
  console.error('  这不是失败，是要求你**一次**确认该环境的基线。')
  process.exit(2)
}

console.log('基线（' + key + '）: ' + entry.floor + '（记录于 ' + (entry.commit || '?') + ' ' + (entry.updatedAt || '').slice(0, 10) + '）')

if (n < entry.floor) {
  console.error('')
  console.error('✗ 断言数低于基线：' + n + ' < ' + entry.floor + '（少了 ' + (entry.floor - n) + ' 项）')
  console.error('  铁律②断言只加不减。先弄清少的是哪几条：')
  console.error('    node scripts/check-assertions.mjs --update 之外，请对比历史输出或 git log 找被删的断言。')
  process.exit(1)
}
if (n > entry.floor) {
  console.log('')
  console.log('✓ 通过：' + n + ' >= ' + entry.floor + '（比基线多了 ' + (n - entry.floor) + ' 项）')
  console.log('  建议在提交时把这个档位的基线抬上去：node scripts/check-assertions.mjs --update')
  process.exit(0)
}
console.log('')
console.log('✓ 通过：' + n + ' == ' + entry.floor + '（与基线一致）')
process.exit(0)
