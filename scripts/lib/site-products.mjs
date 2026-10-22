// 官网上"每个产品的版本号"的抽取与比对 —— 纯函数，不碰网络、不碰文件，便于单测。
//
// 为什么需要它：官网同时展示 4 条独立的版本线（桌面端进销存 / 手机端 App / 手机端网页层 /
// 驾驶舱），而 `lib/site-version.mjs` + release.mjs 只同步"桌面端"一条。结果是实测漂移：
//   · products/inventory.html 的「手机 v1.2.0」落后了一周多（实际 1.3.2）
//   · products/cockpit.html 的 chip 停在 v1.0.1（实际 1.0.12）
// 修一个、其余继续漂，是"只覆盖一条线"的必然结果。
//
// ⚠️ 多版本线的坑（都踩过）：
//   · 手机端：App 安装包版本 ≠ 网页层热更版本。App 内「更多」看到的是**网页层**版本，
//     比安装包号高是正常的，两者不能互相推断。
//   · minidb：桌面壳（desktop/package.json = 1.0.0）与 Go 服务端/CLI（2.0.0）是两条线，
//     站点那个页面讲的是 Web 界面+桌面壳，就该取桌面壳那条。混用会把两个组件的号拼在一起。
//   · 不能从"别的检出"推断版本：D:\B6-通用进销存 / B7-进销存代码 的 package.json 是 2.3.0，
//     那是另一条分支，不是发布版本。

/** 语义化版本比较：a>b 返回正数，a<b 返回负数，相等 0 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/** 表格/卡片里那种「桌面 vX · 手机 vY」的一对版本号 */
export const PAIRED_VERSION_RE = /桌面版?\s*v([0-9]+(?:\.[0-9]+)*)\s*[·・]\s*手机版?\s*v([0-9]+(?:\.[0-9]+)*)/

/** 自研产品的 chip：「自研 · 自用 · vX」 */
export const SELF_BUILT_CHIP_RE = /自研\s*[·・]\s*自用\s*[·・]\s*v([0-9]+(?:\.[0-9]+)*)/

/** 手机端网页层版本：括号里的纯版本号，如「（当前 1.4.49）」 */
export const WEB_LAYER_RE = /（当前\s*([0-9]+\.[0-9]+\.[0-9]+)）/

/** 从「桌面 vX · 手机 vY」里抽出两个版本 */
export function extractPairedVersions(html) {
  const m = String(html).match(PAIRED_VERSION_RE)
  return m ? { desktop: m[1], mobileApp: m[2] } : null
}

/** 从「自研 · 自用 · vX」chip 里抽出版本 */
export function extractSelfBuiltVersion(html) {
  const m = String(html).match(SELF_BUILT_CHIP_RE)
  return m ? m[1] : null
}

/** 抽出手机端网页层版本 */
export function extractWebLayerVersion(html) {
  const m = String(html).match(WEB_LAYER_RE)
  return m ? m[1] : null
}

/**
 * 首页「拿数字说话」里的某个数据格：按 label 文字定位到那一格，再读它的 datum-num。
 *
 * 为什么需要它：那一格里有一格写的是「桌面版当前版本 1.2.0」——
 * 首页第 4 个版本展示位（前三个是产品卡上的三个版本号）。
 * 2026-09-25 扫描首页所有形如 x.y.z 的字符串时才发现它没被闸门覆盖。
 * 直接用正则取第一个 datum-num 会命中「10 年」，所以必须按 label 锚定。
 */
export function datumNumber(labelText) {
  return (html) => {
    const chunks = String(html).split(/<div class="datum">/).slice(1)
    for (const chunk of chunks) {
      if (chunk.includes(labelText)) {
        const m = chunk.match(/<span class="datum-num">([^<]+)<\/span>/)
        if (m) return m[1].trim()
      }
    }
    return null
  }
}

/**
 * 首页产品卡：先按卡片标题定位到那一张卡，再读卡内的「自研 · 自用 · vX」。
 *
 * 为什么需要它：首页同时有两张自研卡（CEO 驾驶舱 / 经营数据台），
 * 而 extractSelfBuiltVersion 只取第一个匹配，两个展示位会读到同一个值互相串。
 * 实测教训：这两张卡原先根本不在 SITE_SLOTS 里，于是首页驾驶舱卡停在 v1.0.1
 * （实际已 1.0.13）很久都没人发现 —— 闸门没覆盖的位置就等于没闸门。
 */
export function cardChipVersion(productName) {
  return (html) => {
    // 以卡片开标签切分，第 0 段是卡片区之前的正文，丢掉
    const chunks = String(html).split(/<article class="card">/).slice(1)
    for (const chunk of chunks) {
      if (chunk.includes(productName)) {
        const m = chunk.match(SELF_BUILT_CHIP_RE)
        if (m) return m[1]
      }
    }
    return null
  }
}

/**
 * 站点上"每个展示位"该由哪个产品线负责。
 * product 是 PRODUCTS 的键；extractor 说这个位置怎么读。
 */
export const SITE_SLOTS = [
  {
    page: '/',
    label: '首页 · 产品卡',
    products: ['desktop', 'mobileApp'],
    extract: extractPairedVersions,
  },
  {
    // 首页另外两张自研卡。它们原先不在闸门里，导致首页驾驶舱卡停在 v1.0.1
    // 而实际已是 1.0.13 却无人报警（2026-09-25 补上）。
    page: '/',
    label: '首页 · 驾驶舱卡',
    products: ['cockpit'],
    extract: cardChipVersion('CEO 驾驶舱'),
  },
  {
    page: '/',
    label: '首页 · 数据台卡',
    products: ['minidb'],
    extract: cardChipVersion('经营数据台'),
  },
  {
    // 首页第 4 个版本展示位：「拿数字说话」里那格「桌面版当前版本 1.2.0」。
    // 扫首页所有 x.y.z 字符串时才发现它一直没被覆盖。
    page: '/',
    label: '首页 · 数据段版本格',
    products: ['desktop'],
    extract: datumNumber('桌面版当前版本'),
  },
  {
    page: '/download/',
    label: '下载页 · 顶部 chip',
    products: ['desktop', 'mobileApp'],
    extract: extractPairedVersions,
  },
  {
    page: '/download/',
    label: '下载页 · 手机说明里的网页层版本',
    products: ['mobileWeb'],
    extract: extractWebLayerVersion,
  },
  {
    page: '/products/inventory.html',
    label: '产品页 · 进销存',
    products: ['desktop', 'mobileApp'],
    extract: extractPairedVersions,
  },
  {
    page: '/products/cockpit.html',
    label: '产品页 · 驾驶舱',
    products: ['cockpit'],
    extract: extractSelfBuiltVersion,
  },
  {
    page: '/products/minidb.html',
    label: '产品页 · 数据台',
    products: ['minidb'],
    extract: extractSelfBuiltVersion,
  },
]

/**
 * 把「某页读出来的展示值」与「权威版本」逐个比对。
 * @returns {{ok: boolean, rows: Array<{slot:string, product:string, shown:string|null, expected:string|null, match:boolean, note:string}>}}
 */
export function compareSlots(shownBySlot, expectedByProduct) {
  const rows = []
  for (const slot of SITE_SLOTS) {
    const shown = shownBySlot[slot.label] || null
    for (const product of slot.products) {
      const expected = expectedByProduct[product] ?? null
      const value = shown && typeof shown === 'object' ? shown[product] : shown
      let note = ''
      if (value == null) note = '页面里读不到这个版本号（结构变了？）'
      else if (expected == null) note = '拿不到权威版本（源文件缺失？）'
      else if (value !== expected) {
        note = compareVersions(value, expected) < 0 ? '落后' : '超前'
      }
      rows.push({
        slot: slot.label,
        product,
        shown: value ?? null,
        expected,
        match: value != null && expected != null && value === expected,
        note,
      })
    }
  }
  const ok = rows.every((r) => r.match)
  return { ok, rows }
}
