// 官网「其余页面」的桌面版本号同步 —— 纯函数，不碰网络、不碰文件，便于单测。
//
// 为什么需要它：release.mjs 的 deployWeb 从 2026-08 起只管两处 ——
//   ① /download/index.html 的桌面文案与 exe 名
//   ② 主站首页的「桌面 vX」文案
// 于是下面这些地方**从来没被同步过**，每次都靠人记得手工改，已经漏了三次：
//   ① 产品页 /products/inventory.html 的主按钮 href 还指着已被归档的
//      general-inventory-setup-1.0.9.exe → 公网实测 404（2026-09-16）
//   ② 产品页 / docs 页 / 首页数据区的版本号长期停在旧值（1.1.8 发布后仍写 1.0.9 / 1.0.10）
//   ③ 下载页「版本信息」三处（发布日期 / 安装包大小 / 校验指纹）也从不更新，
//      其中**校验指纹写错会让客户以为文件被篡改**，对 B 端下载是硬伤
//
// 这里把「其余页面」的改写做成与 oldV 无关的幂等操作：不管页面上现在写的是哪个版本，
// 只要落在下面四种已知写法里，就一律改成目标版本。
// 手机版（fishing-inventory-mobile-X.Y.Z.apk / 手机 vX）**绝不碰**。

/** 写法一：桌面 vX / 桌面版 vX / Windows 版 vX */
export const DESKTOP_LABEL_RE = /((?:桌面版|桌面|Windows 版)\s?v)([0-9][0-9.]*)/g

/** 写法二：p-more 交叉链接里的 `<small>· vX</small>`（注意与更新日志的 `<span class="ver">vX<small>` 不同） */
export const P_MORE_LINK_RE = /(<small>\s*·\s*v)([0-9][0-9.]*)(<\/small>)/g

/** 写法三：安装包链接里的版本（官网本地包与更新源两种命名都认） */
export const EXE_LINK_RE = /((?:inventory-system|general-inventory)-setup-)([0-9][0-9.]*)(\.exe)/g

/** 写法四：首页数据区的「<数字> + 桌面版当前版本」这一对（版本号与标签分处两个元素，前面三种写法都抓不到） */
export const HOMEPAGE_DATUM_RE = /(<span class="datum-num">)([0-9][0-9.]*)(<\/span>\s*<span class="datum-label">桌面版当前版本)/

/** 写法五：括号里的版本号，如 docs 页的「下载 Setup (vX)」 */
export const PAREN_VERSION_RE = /(\(v)([0-9][0-9.]*)(\))/g

export const desktopLabels = (html) => [...new Set([...html.matchAll(DESKTOP_LABEL_RE)].map((m) => m[2]))]
export const pMoreVersions = (html) => [...new Set([...html.matchAll(P_MORE_LINK_RE)].map((m) => m[2]))]
export const exeVersions = (html) => [...new Set([...html.matchAll(EXE_LINK_RE)].map((m) => m[2]))]
export const parenVersions = (html) => [...new Set([...html.matchAll(PAREN_VERSION_RE)].map((m) => m[2]))]
export const homepageDatum = (html) => (html.match(HOMEPAGE_DATUM_RE) || [])[2]

/**
 * 把页面里所有「已知写法的桌面版本号」改成 version。幂等：已经是目标版本时输出不变。
 * @returns {{html: string, touched: string[]}} touched 是实际被改动的写法名，便于日志与自检
 */
export function replaceSiteDesktopVersion(html, version) {
  const touched = []
  let out = html

  if (desktopLabels(out).some((v) => v !== version)) touched.push('桌面 v 文案')
  out = out.replace(DESKTOP_LABEL_RE, '$1' + version)

  if (pMoreVersions(out).some((v) => v !== version)) touched.push('p-more 链接')
  out = out.replace(P_MORE_LINK_RE, '$1' + version + '$3')

  if (exeVersions(out).some((v) => v !== version)) touched.push('安装包链接')
  out = out.replace(EXE_LINK_RE, '$1' + version + '$3')

  if (parenVersions(out).some((v) => v !== version)) touched.push('括号版本号')
  out = out.replace(PAREN_VERSION_RE, '$1' + version + '$3')

  const datum = homepageDatum(out)
  if (datum && datum !== version) touched.push('首页数据区')
  out = out.replace(HOMEPAGE_DATUM_RE, '$1' + version + '$3')

  return { html: out, touched }
}

/**
 * 自检：页面里不许残留旧桌面版本号。
 * 只查上面五种**当前版本位**，不碰更新日志的历史条目（v0.3.2 / v1.0.9 那些是版本历史，本就该留着）。
 */
export function assertSiteCurrent(html, version, label) {
  const stale = [
    ...desktopLabels(html),
    ...pMoreVersions(html),
    ...exeVersions(html),
    ...parenVersions(html),
  ].filter((v) => v !== version)
  if (stale.length) {
    throw new Error(label + ' 仍残留旧桌面版本号：' + [...new Set(stale)].join(' / ') + '（应为 ' + version + '）')
  }
  const datum = homepageDatum(html)
  if (datum && datum !== version) {
    throw new Error(label + ' 数据区「桌面版当前版本」仍是 ' + datum + '，应为 ' + version)
  }
  return true
}

/**
 * 下载页「版本信息」三处：发布日期 / 安装包大小 / 校验指纹。
 * @returns {{html: string, touched: string[]}}
 */
export function rewriteVersionFacts(html, { date, size, sha16 }) {
  const touched = []
  let out = html
  const mb = String(Math.round(size / 1048576))
  const bytes = String(size).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  const pairs = [
    ['发布日期', /(<h3><span class="dot"><\/span>发布日期<\/h3><p>)([^<]*)(<\/p>)/, '$1' + date + '$3'],
    ['安装包大小', /(<h3><span class="dot"><\/span>安装包大小<\/h3><p>约 )[0-9.]+( MB（)[0-9,]+( 字节）<\/p>)/, '$1' + mb + '$2' + bytes + '$3'],
    ['校验指纹', /(SHA-512 前 16 位：)[A-Za-z0-9+/=]+(<\/p>)/, '$1' + sha16 + '$2'],
  ]
  for (const [name, re, rep] of pairs) {
    if (re.test(out)) {
      const before = out
      out = out.replace(re, rep)
      if (out !== before) touched.push(name)
    }
  }
  return { html: out, touched }
}

/** 从下载页里读出「版本信息」三处的当前值（供发布后自检用） */
export function readVersionFacts(html) {
  return {
    date: (html.match(/发布日期<\/h3><p>([^<]*)<\/p>/) || [])[1],
    size: (html.match(/安装包大小<\/h3><p>约 [0-9.]+ MB（([0-9,]+) 字节）<\/p>/) || [])[1],
    sha16: (html.match(/SHA-512 前 16 位：([A-Za-z0-9+/=]+)<\/p>/) || [])[1],
  }
}

/** 更新日志里有没有为 version 写条目（没写只告警，不中止发布） */
export function hasChangelogEntry(html, version) {
  return new RegExp('<span class="ver">v' + version.replace(/\./g, '\\.') + '<small>').test(html)
}
