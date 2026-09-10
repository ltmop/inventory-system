// 写操作通道黑名单：游客模式（跳过登录）下这些通道一律拒绝，保持只读。
// 读通道（list/status/query/detail/info）放行，游客可以浏览数据。
// 云账号登录相关通道始终放行（游客也要能登录/注册）。

const WRITE_CHANNELS = new Set([
  // 商品/分类/单位
  'product:create', 'product:update', 'product:batchUpdate', 'product:delete', 'product:mark',
  'category:create', 'category:rename', 'category:delete', 'category:move',
  'unit:create', 'unit:update', 'unit:delete', 'unit:move', 'unit:allowsDecimal',
  'template:apply',
  // 入库/出库/盘点/报损
  'inbound:create',
  'outbound:confirm', 'outbound:checkout', 'outbound:return', 'outbound:exchange',
  'stocktake:create', 'stocktake:updateItem', 'stocktake:complete', 'stocktake:submit',
  'import:batch',
  'waste:create',
  // 供应商/客户/收支
  'supplier:create', 'supplier:update', 'supplier:delete', 'supplier:pay',
  'customer:create', 'customer:update', 'customer:delete', 'payment:record',
  'expense:create', 'expense:update', 'expense:delete',
  // 组合商品/采购单/价签
  'part:set', 'part:setMany', 'kit:save', 'kit:delete',
  'po:create', 'po:receive', 'po:cancel',
  'priceTier:set', 'priceTier:delete',
  // 员工/备份/图片/收款码
  'user:create', 'user:update', 'user:delete', 'user:setStaffLogin',
  'backup:now', 'backup:restore', 'backup:setExtraDir', 'backup:clearExtraDir',
  'photo:save', 'photo:delete', 'payment:saveQr', 'payment:deleteQr',
  // AI/知识库
  'ai:setProvider', 'ai:setKey', 'ai:clearKey', 'ai:chat', 'ai:parseInboundNote', 'ai:transcribe',
  'ai:bindLicense',
  'voice:parseOrder', 'voice:parseOrderAudio',
  'knowledge:save', 'knowledge:update', 'knowledge:delete',
  'doubao:setKey', 'doubao:clearKey', 'doubao:analyzeImage', 'doubao:chat',
  'voice:transcribe', 'voice:download', 'tts:speak', 'tts:download', 'kws:download', 'kws:reset',
  'feedback:send',
  'server:toggle', 'server:regenerateToken',
  'update:downloadAndInstall', 'license:activate',
  'onboarding:finish', 'onboarding:reset',
  // 云同步写操作（游客不允许上传/改配）
  'cloud:syncNow', 'cloud:backupNow', 'cloud:restore', 'cloud:regenViewLink', 'cloud:pair', 'cloud:logout', 'cloud:dismissRestore',
])

// 云账号登录相关通道始终放行（游客也要能登录/注册）
const ALWAYS_ALLOW = new Set(['cloud:registerAccount', 'cloud:loginAccount', 'cloud:status', 'cloud:listBackups'])

export function isGuestWriteChannel(channel: string): boolean {
  if (ALWAYS_ALLOW.has(channel)) return false
  return WRITE_CHANNELS.has(channel)
}
