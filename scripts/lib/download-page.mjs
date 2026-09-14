// 官网下载页的「桌面版本号」改写 —— 纯函数，不碰网络、不碰文件，便于单测。
//
// 为什么单独抽出来：这件事**已经踩过三次坑**，每次都是「exe 已换、页面没换 → 官网主按钮 404」
// 或者「exe/href/chip 都换了，用户真正会读的那几行还在写旧版本」。
//   ① 1.1.1：脚本把手机版号硬编码成 1.1.1 去计数，桌面号一到 1.1.1 必然误报中止；
//   ② 1.1.2：改成整页盲替换版本号，把手机版文件名 `fishing-inventory-mobile-1.1.2.apk` 一起改了；
//   ③ 1.1.6：只认 exe 文件名和「桌面 v」前缀，漏掉「桌面版 v」「Windows 版 v」两种写法
//      （meta description、底部当前版本、主按钮文案三处全部留在旧版本）。
// 抽出来之后，`scripts/verify-download-page.mjs` 用固定夹具把这三条规则钉死，
// 不用真的发一次版才能知道改坏没有。

/** 桌面上「版本号写在哪」的全部已知写法：桌面 vX / 桌面版 vX / Windows 版 vX */
export const DESKTOP_MENTION_RE = /((?:桌面版|桌面|Windows 版)\s?v)([0-9][0-9.]*)/g

/** 手机版安装包文件名（这是判定"手机版有没有被误改"的唯一可靠单位） */
export const MOBILE_APK_RE = /fishing-inventory-mobile-[0-9][0-9.]*\.apk/g

/** 页面上出现过的桌面版本号集合（去重） */
export const desktopMentions = (html) => [...new Set([...html.matchAll(DESKTOP_MENTION_RE)].map((m) => m[2]))]

/** 页面上出现过的手机版 apk 文件名集合（去重） */
export const mobileApks = (html) => [...new Set(html.match(MOBILE_APK_RE) || [])]

/**
 * 只把「桌面/桌面版/Windows 版 vX」文案换成 version。
 * 主站首页（/var/www/junchengzn/index.html）用这个 —— 那里没有安装包名，也没有手机版字样。
 */
export const replaceDesktopMentions = (html, version) => html.replace(DESKTOP_MENTION_RE, '$1' + version)

const countOccurrences = (text, needles) => needles.reduce((n, s) => n + (text.split(s).length - 1), 0)

/**
 * 把下载页里的桌面版本号改成 version。
 *
 * 只动桌面这三样：exe 文件名（两种命名）+ 桌面/桌面版/Windows 版 文案。
 * 手机版（apk 文件名 / 手机 vX / 手机版 vX）**绝不碰**，靠「apk 文件名出现次数必须不变」守。
 *
 * @throws 页面结构变了（找不到 exe 名）/ 手机版被误改 / 换完仍有旧桌面版本号 —— 宁可不发，也不发半截。
 */
export function rewriteDownloadPage(html, version) {
  // 两种命名都认：更新源里是 `inventory-system-setup-*.exe`，官网本地包是 `general-inventory-setup-*.exe`。
  // 页面上通常两种都在（主按钮 + 备用线路），但只出现一种时也必须能找到版本号。
  const mv = html.match(/(?:inventory-system|general-inventory)-setup-([0-9][0-9.]*)\.exe/)
  if (!mv) throw new Error('下载页里找不到 x.y.z 安装包名（inventory-system-setup / general-inventory-setup）—— 页面结构可能又变了，请人工确认后再发')
  const oldV = mv[1]
  const apks = mobileApks(html)
  const mobileBefore = countOccurrences(html, apks)
  const desktopBefore = desktopMentions(html)

  let out = html
  if (oldV !== version) {
    out = out
      .split('inventory-system-setup-' + oldV + '.exe').join('inventory-system-setup-' + version + '.exe')
      .split('general-inventory-setup-' + oldV + '.exe').join('general-inventory-setup-' + version + '.exe')
  }
  // ⚠️ 这一段必须与 oldV 无关地独立执行：oldV 是从 exe 文件名解析的，
  //    页面可能已经换了文件名、文案却还是旧的（1.1.6 就是）。
  out = out.replace(DESKTOP_MENTION_RE, '$1' + version)

  const desktopAfter = desktopMentions(out)
  if (desktopAfter.some((v) => v !== version)) throw new Error('下载页仍残留旧桌面版本号：' + desktopAfter.join(' / '))
  const mobileAfter = countOccurrences(out, apks)
  if (mobileBefore !== mobileAfter) throw new Error('手机版版本号被误改（' + mobileBefore + ' → ' + mobileAfter + '），已中止')

  return { html: out, oldV, desktopBefore, desktopAfter, mobileBefore, mobileAfter }
}

/** 取下载页的主按钮（指向官网本地安装包的那个大按钮） */
export function mainButton(html) {
  const m = html.match(/<a href="([^"]*general-inventory-setup-[0-9][0-9.]*\.exe)"[^>]*>([^<]*)</)
  return m ? { href: m[1], text: m[2].trim() } : null
}

/** 把「备用线路」（更新源直链）的主按钮 href 换指官网本地包 */
export function pointMainButtonAtLocal(html, version) {
  return html.replace(
    'href="https://sync.junchengzn.com/updates/inventory-system-setup-' + version + '.exe" class="btn btn-accent btn-lg"',
    'href="/download/general-inventory-setup-' + version + '.exe" class="btn btn-accent btn-lg"',
  )
}

/**
 * 发布后自检：桌面文案全是 version、主按钮文案写着 version。
 *
 * ⚠️ 只查「页面里含 version」是不够的 —— 页面上 chip / exe 名 / 备用线路任意一处有它就过了，
 *    而主按钮文案可以是旧版本（1.1.6 第一次发布就是这么过掉的）。
 */
export function assertPageCurrent(html, version) {
  const stale = desktopMentions(html).filter((v) => v !== version)
  if (stale.length) throw new Error('官网下载页还残留旧桌面版本号：' + stale.join(' / '))
  const btn = mainButton(html)
  if (!btn) throw new Error('官网下载页找不到主按钮（结构可能又变了）')
  if (!btn.text.includes(version)) throw new Error('官网主按钮文案没跟上版本：按钮写「' + btn.text + '」，本版本是 ' + version)
  return { button: btn, desktop: desktopMentions(html) }
}
