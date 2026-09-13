// 销售渠道（channel）—— 首单北极星判据的字段口径，单一事实源。
//
// 为什么要有这个模块：这一套取值同时被三处使用，
//   ① electron/db.js  —— 建表 + 老库补列 + 默认值触发器
//   ② electron/commands/outbound.js —— 开单时校验/落库（Shopee 必须显式传）
//   ③ scripts/migrate-transaction-channel.mjs —— 历史回填与盘点
// 写死在三处必然会漂移，所以集中在这里。
//
// 口径（产品 2026-09-12 定）：
//   · 默认「线下」—— 门店大部分销售是线下，不填就是线下
//   · 「Shopee」**必须由调用方显式传入**，绝不自动推断 ——
//     首单北极星判据是 `type=out 且 amount>0 且 channel=Shopee`，
//     一旦哪天有人想"接近了就算"，北极星就会从"未出"变成"已出"，比误报更危险。
//   · 「优选仓」用于发往优选仓的批次（历史那 31 笔的 operator 字面就写着"优选仓发货"）
//   · 「其他」兜底

export const CHANNELS = ['线下', 'Shopee', '优选仓', '其他']

/** 未指定时的默认渠道（也是 DB 层触发器的默认值） */
export const DEFAULT_CHANNEL = '线下'

/**
 * 校验渠道取值。
 * 不传 / 空 → 返回 undefined，表示"交给数据库层触发器兜默认值"（新单据默认线下）。
 * @param {unknown} v
 * @returns {string|undefined}
 */
export function assertChannel(v) {
  if (v == null || v === '') return undefined
  const s = String(v).trim()
  if (!CHANNELS.includes(s)) {
    throw new Error(`销售渠道必须是：${CHANNELS.join(' / ')}，收到：${v}`)
  }
  return s
}
