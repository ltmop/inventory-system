// 商品显示名的**唯一实现**（纯 JS，无 electron、无 db 依赖）——主进程 / 中心库服务端 / 手机端共用。
//
// 为什么放在 electron/lib/ 而不是 electron/commands/：
//   命令层（口径层）只能有一个入口 commandsLive.js（闸门 check:webupdate 会红），
//   server.js / ai.js / cloudSnapshot.js / voiceOrder.js 不许直接 import './commands/*'。
//   而显示名是**格式**不是业务口径，跟 lib/restockAdvice.js（主进程/手机端专用）同类，
//   所以放这里：既让所有非命令层模块能用同一份，又不动"口径只走命令层"这条红线。
//   electron/commands/helpers.js 的 productLabel 就是 re-export 本文件，命令层仍然只认这一份。
//
// 与 src/lib/formatters.ts 的 productName/joinNameParts 是同口径双胞胎
//   （和 restockAdvice.js ↔ restockAdvice.ts 一个道理：打包只含 electron/**，主进程不得引用 src/**）。
//   test-backend.mjs 里有一条断言逐例比对两边输出，改一边不改另一边会红。
//
// 为什么规格必须进名字（老板 2026-09-22 反馈「商品规格没有合并、名字不统一」的界面根源）：
//   一个系列几十个尺码（3.6m / 4.5m / 5.0号…），名字若只拼「品牌+型号」，
//   库存列表与开单页里同系列几行长得一模一样，店员只能一条条点开看 —— 这不是数据脏，
//   是显示名把最有区分度的字段（规格）丢掉了。
//   现场口径：`sub_category` 就是「规格」列（docs/设计-品牌品类规格三层与录入归一）。

/** 按「品牌 → 型号/系列 → 规格」顺序拼接，跳过空值与已被包含的重复词 */
export function joinNameParts(...parts) {
  const kept = []
  for (const raw of parts) {
    const part = String(raw ?? '').trim()
    if (!part) continue
    // 型号里已经带了规格时（型号「赤刃 3.6m」+ 规格「3.6m」）只显示一次
    if (kept.some((x) => x === part || x.includes(part) || part.includes(x))) continue
    kept.push(part)
  }
  return kept.join(' ')
}

/** 商品显示名：品牌 + 型号/系列 + 规格（子类），都没有才回退 SKU */
export function productLabel(p) {
  if (!p) return ''
  return joinNameParts(p.brand, p.model, p.sub_category) || p.sku_code || ''
}
