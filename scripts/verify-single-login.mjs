// D1 机器校验：**全软件只有一个登录入口**（身份统一交办单的判定线 D1）
//
// 为什么要有这个脚本：D1 是"找不到第二个登录按钮"——一种**否定性**要求，
// 而否定性要求最容易在后续改动里被悄悄破坏（有人再加一个登录弹窗，没人会发现）。
// 所以把判据写成可复算的检查，而不是靠人记得。
//
// 判据（每条都能在源码里数出来）：
//   ① 已删除的两道全屏门（CloudLoginGate / LoginGate）不再被任何文件引用，文件本身也不存在
//   ② 渲染「登录表单」的地方**恰好 1 处**（调用 cloud:loginAccount 的文件）
//   ③ 渲染「注册表单」的地方**恰好 1 处**（调用 cloud:registerAccount 的文件）
//   ④ 没有任何地方再调用 openCloudGate / setLoginGateOpen（"打开另一个登录门"的机制）
//   ⑤ store 里 openCloudGate / cloudGateIntent 已移除
//
// 跑法：node scripts/verify-single-login.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'src')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')) }
}

/** 收集 src 下所有 .ts/.tsx，返回 [{rel, text}] */
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collect(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push({ rel: path.relative(ROOT, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') })
  }
  return out
}
const files = collect(SRC)
/** 真引用：import 自该模块，或 JSX 里真的用了它。**注释里提到名字不算**（否则注释会把自己判失败）。 */
const realRefs = (name) =>
  files
    .filter((f) => new RegExp(`from\\s+['"]@/components/${name}['"]|<${name}[\\s/>]`).test(f.text))
    .map((f) => f.rel)
/** 真的在调这个 IPC 通道（排除 guestChannels 那种白名单字符串） */
const realInvoke = (channel) =>
  files
    .filter((f) => new RegExp(`invoke\\(\\s*['"\`]${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(f.text))
    .map((f) => f.rel)

console.log('扫描 ' + files.length + ' 个 src 下的 .ts/.tsx 文件\n')

console.log('=== ① 两道全屏登录门已彻底移除 ===')
for (const name of ['CloudLoginGate', 'LoginGate']) {
  ok(name + ' 文件已删除', !fs.existsSync(path.join(SRC, 'components', name + '.tsx')))
  const refs = realRefs(name)
  ok('没有任何文件 import / 使用 ' + name, refs.length === 0, refs.join(', '))
}

console.log('\n=== ② 登录表单恰好一处 ===')
const loginForms = realInvoke('cloud:loginAccount')
ok('调用登录通道的地方恰好 1 处', loginForms.length === 1, loginForms.join(', '))
if (loginForms.length === 1) console.log('        唯一登录表单：' + loginForms[0])

console.log('\n=== ③ 注册表单恰好一处 ===')
const regForms = realInvoke('cloud:registerAccount')
ok('调用注册通道的地方恰好 1 处', regForms.length === 1, regForms.join(', '))
if (regForms.length === 1) console.log('        唯一注册表单：' + regForms[0])
ok('登录与注册在同一个文件里（同一个账号页）', loginForms.length === 1 && regForms.length === 1 && loginForms[0] === regForms[0],
  loginForms[0] + ' vs ' + regForms[0])

console.log('\n=== ④ 没有"打开另一个登录门"的机制残留 ===')
for (const k of ['openCloudGate', 'setLoginGateOpen']) {
  const r = files.filter((f) => f.text.includes(k)).map((f) => f.rel)
  ok('无任何文件再出现 ' + k, r.length === 0, r.join(', '))
}

console.log('\n=== ⑤ store 里的门相关状态已移除 ===')
const store = files.find((f) => f.rel === 'src/store/appStore.ts')
ok('appStore 里没有 openCloudGate', !!store && !store.text.includes('openCloudGate'))
ok('appStore 里没有 cloudGateIntent', !!store && !store.text.includes('cloudGateIntent'))

console.log('\n=== 附加：账号页确实是唯一的账号面 ===')
const acct = files.find((f) => f.rel === 'src/pages/AccountPage.tsx')
ok('账号页渲染了 CloudCard（含唯一登录表单）', !!acct && acct.text.includes('<CloudCard />'))
ok('账号页渲染了 StaffCard（员工名单已并入）', !!acct && acct.text.includes('<StaffCard />'))
const settings = files.find((f) => f.rel === 'src/pages/SettingsPage.tsx')
ok('设置页不再重复渲染 StaffCard（避免第二个账号面）', !!settings && !settings.text.includes('<StaffCard />'))

console.log('\n================ 结果 ================')
console.log('PASS ' + pass + '   FAIL ' + fail)
process.exit(fail === 0 ? 0 : 1)
