// 出库（FIFO）、收银开单、退货、换货
import {
  assertQuantity,
  assertFen,
  assertPayMethod,
  PRICE_TIERS,
  inTransaction,
  now,
  productLabel,
  logAudit,
  addBackToLatestBatch,
} from './helpers.js'

/**
 * 按入库日期升序扣减批次；跨批次拆成多条 transactions
 * unit_price 记批次成本价，selling_price 记实际售价（利润 = selling_price - unit_price）
 *
 * 赊账扩展（客户余额模型）：
 * - customerId 可选；散客（不传）必须全额付清，部分付款/纯赊账会报"赊账必须选客户"
 * - paidAmount=实收金额（分）。省略或等于应付总额 → 各流水 paid_amount 存 NULL（全额付清）；
 *   小于应付 → 每条流水记实收，按 FIFO 顺序分摊，未被覆盖的批次流水记 0（0 也是赊账，与 NULL 语义不同）；
 *   传 0 → 纯赊账。paidAmount 超过应付总额直接报错。
 * - 返回值带 totalDue / paidAmount / creditAmount（本单赊账金额），方便前端提示。
 * 多级定价扩展（v2.0）：tier 可选（retail/regular/VIP/wholesale/promo）。
 * 售价取值优先级：显式 sellingPrice > 该商品 tier 档次价 > 商品建议零售价（仅传了 tier 时才回退）。
 * 传了 tier 但该商品没设该档 → 回退 suggest_price（没有则记 NULL，前端应手填）；
 * 不传 tier → 行为与旧版完全一致。赊账/客户逻辑在售价定下来之后走，不受影响。
 * 收款方式扩展：payMethod 可选（现金/微信/支付宝/其他）。只有真正收到钱时才落库——
 * 全额付清记各条流水；部分付款且实收>0 同样记；纯赊账（paidAmount=0）强制记 NULL（没有现金移动）。
 * 老数据/未传的一律 NULL=未记录，日结拆分单独归入"未记录"。
 */
export function confirmOutbound(db, { productId, quantity: rawQuantity, sellingPrice, operator, customerId, paidAmount, tier, payMethod, allowExpired }) {
  // 入口先校验：数量为 0/负数时直接抛错；米商品（鱼线）允许小数出库
  const prod0 = db.prepare('SELECT unit FROM products WHERE id = ?').get(productId)
  if (!prod0) throw new Error('商品不存在')
  const quantity = assertQuantity(rawQuantity, '出库数量', prod0.unit === '米' ? '米' : '件')
  if (sellingPrice != null) assertFen(sellingPrice, '出库售价')
  payMethod = assertPayMethod(payMethod)
  if (tier != null) {
    if (!PRICE_TIERS.includes(tier)) throw new Error(`价格档次必须是：${PRICE_TIERS.join(' / ')}，收到：${tier}`)
    if (sellingPrice == null) {
      const tierRow = db
        .prepare('SELECT price FROM price_tiers WHERE product_id = ? AND tier = ?')
        .get(productId, tier)
      sellingPrice = tierRow?.price ?? null
      // 该商品没设这档价 → 回退建议零售价
      if (sellingPrice == null) {
        const prod = db.prepare('SELECT suggest_price FROM products WHERE id = ?').get(productId)
        sellingPrice = prod?.suggest_price ?? null
      }
    }
  }
  if (paidAmount != null) {
    assertFen(paidAmount, '实收金额')
    if (sellingPrice == null) throw new Error('记实收金额时必须填写售价')
    const due = quantity * sellingPrice
    if (paidAmount > due) throw new Error(`实收金额不能超过应付总额（应付 ${due} 分，实收 ${paidAmount} 分）`)
    if (paidAmount < due && customerId == null) throw new Error('赊账必须选客户')
  }
  return inTransaction(db, () => {
    if (customerId != null) {
      const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)
      if (!cust) throw new Error('客户不存在')
    }
    // FEFO：先到期先出（有 expiry_date 的按到期日升序优先扣），无到期日的按 FIFO 兜底
    const batches = db
      .prepare(
        `SELECT * FROM inventory_batches
         WHERE product_id = ? AND quantity > 0
         ORDER BY
           CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
           expiry_date ASC,
           inbound_date ASC,
           id ASC`,
      )
      .all(productId)
    const total = batches.reduce((s, b) => s + b.quantity, 0)
    if (total < quantity) return { ok: false, shortage: quantity - total }

    // 过期拦截：计划扣减的批次里有已过期的（到期日 < 今天），默认拒绝出库——杜绝卖过期饵料。
    // 老板确认要低价处理时前端传 allowExpired: true 才放行。
    const todayStr = now().slice(0, 10)
    const expiredBatches = batches
      .filter((b) => b.expiry_date && b.expiry_date < todayStr)
      .map((b) => ({ batch_no: b.batch_no, expiry_date: b.expiry_date, quantity: b.quantity }))
    if (expiredBatches.length > 0 && !allowExpired) {
      return { ok: false, expired: true, expiredBatches, total }
    }

    const ts = now()
    const totalDue = sellingPrice != null ? quantity * sellingPrice : null
    // 是否赊账单（部分付款/纯赊账）：只有赊账单才往 paid_amount 写实收，否则保持 NULL=全额付清
    const isCredit = totalDue != null && paidAmount != null && paidAmount < totalDue
    // 纯赊账没有现金移动，收款方式强制落空；部分付款实收>0 / 全额付清才记方式
    const methodForTx = isCredit && paidAmount === 0 ? null : payMethod
    let paidLeft = isCredit ? paidAmount : 0
    const allocations = []
    let remaining = quantity
    for (const b of batches) {
      if (remaining <= 0) break
      const deduct = Math.min(b.quantity, remaining)
      const after = b.quantity - deduct
      db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?').run(after, b.id)
      // 实收按 FIFO 顺序分摊到拆出来的每条流水；未覆盖到的记 0（纯赊那段）
      let paid = null
      if (isCredit) {
        paid = Math.min(deduct * sellingPrice, paidLeft)
        paidLeft -= paid
      }
      db.prepare(
        `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount, pay_method)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(productId, b.id, deduct, b.cost_price, sellingPrice ?? null, ts, operator ?? null, customerId ?? null, paid, methodForTx)
      allocations.push({
        batch_id: b.id,
        batch_no: b.batch_no,
        deduct,
        remaining_after: after,
        cost_price: b.cost_price,
      })
      remaining -= deduct
    }
    const outProd = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    logAudit(db, '出库', `${outProd ? productLabel(outProd) : `#${productId}`} x${quantity}`,
      { quantity, sellingPrice: sellingPrice ?? null, totalDue, paidAmount: isCredit ? paidAmount : null, creditAmount: isCredit ? totalDue - paidAmount : 0, customerId: customerId ?? null }, operator)
    return {
      ok: true,
      allocations,
      totalDue,
      paidAmount: isCredit ? paidAmount : null,
      creditAmount: isCredit ? totalDue - paidAmount : 0,
      expiredBatches,
    }
  })
}

/**
 * 一单多商品收银台：一次开单出多种商品，所有行在同一事务里——
 * 任一行库存不足或校验失败，整单回滚不留半截（与盘点提交同原则）。
 * 行项目：{ productId, quantity, sellingPrice }，每行售价必填且 >0（收银台营业额/毛利全靠它）。
 * 收款口径与 confirmOutbound 一致：paidAmount 省略=全额付清（流水 paid_amount 记 NULL）；
 * 不满额=赊账必须选客户，实收按行顺序 + 行内 FIFO 逐条摊销；纯赊账（0）没有现金移动，pay_method 强制 NULL。
 * 返回 { ok, lines:[{productId, quantity, sellingPrice, allocations}], totalDue, paidAmount, creditAmount }
 * 或 { ok:false, shortages:[{productId, name, shortage}] }（哪几个商品不够、各差多少，一次说清）
 */
export function confirmCheckout(db, { items, customerId, paidAmount, payMethod, operator, allowExpired }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('开单商品列表不能为空')
  if (items.length > 50) throw new Error(`一单最多 50 种商品，收到：${items.length}`)
  payMethod = assertPayMethod(payMethod)
  const lines = items.map((it, i) => {
    // 计量单位：米商品（鱼线）允许小数开单
    const prod0 = db.prepare('SELECT unit FROM products WHERE id = ?').get(it.productId)
    if (!prod0) throw new Error(`商品不存在（ID：${it.productId}）`)
    const quantity = assertQuantity(it.quantity, `第 ${i + 1} 行数量`, prod0.unit === '米' ? '米' : '件')
    if (!Number.isInteger(it.sellingPrice) || it.sellingPrice <= 0) {
      throw new Error(`第 ${i + 1} 行售价必须大于 0（单位：分），收到：${it.sellingPrice}`)
    }
    return { productId: it.productId, quantity, sellingPrice: it.sellingPrice, due: quantity * it.sellingPrice }
  })
  const totalDue = lines.reduce((s, l) => s + l.due, 0)
  if (paidAmount != null) {
    assertFen(paidAmount, '实收金额')
    if (paidAmount > totalDue) throw new Error(`实收金额不能超过应付总额（应付 ${totalDue} 分，实收 ${paidAmount} 分）`)
    if (paidAmount < totalDue && customerId == null) throw new Error('赊账必须选客户')
  }
  return inTransaction(db, () => {
    if (customerId != null) {
      const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)
      if (!cust) throw new Error('客户不存在')
    }
    // 先全部查库存（不改数据），不够的商品一次列清，收银员知道该从单子里拿掉哪样
    const planRows = []
    const shortages = []
    for (const l of lines) {
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(l.productId)
      if (!prod) throw new Error(`商品不存在（ID：${l.productId}）`)
      const batches = db
        .prepare(
          `SELECT * FROM inventory_batches
           WHERE product_id = ? AND quantity > 0
           ORDER BY
             CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
             expiry_date ASC,
             inbound_date ASC,
             id ASC`,
        )
        .all(l.productId)
      const total = batches.reduce((s, b) => s + b.quantity, 0)
      if (total < l.quantity) {
        shortages.push({ productId: l.productId, name: productLabel(prod), shortage: l.quantity - total })
      }
      planRows.push({ line: l, batches, prod })
    }
    if (shortages.length > 0) return { ok: false, shortages }
    // 过期拦截：单子里有商品计划扣到已过期批次 → 默认拒绝（杜绝卖过期饵料）；老板确认处理时传 allowExpired 放行
    const todayStr2 = now().slice(0, 10)
    const expiredProducts = planRows
      .map(({ line: l, batches, prod }) => {
        const exps = batches.filter((b) => b.expiry_date && b.expiry_date < todayStr2)
        return exps.length > 0
          ? { productId: l.productId, name: productLabel(prod), expiredBatches: exps.map((b) => ({ batch_no: b.batch_no, expiry_date: b.expiry_date, quantity: b.quantity })) }
          : null
      })
      .filter(Boolean)
    if (expiredProducts.length > 0 && !allowExpired) {
      return { ok: false, expired: true, expiredProducts }
    }
    const ts = now()
    const isCredit = paidAmount != null && paidAmount < totalDue
    // 纯赊账没有现金移动，收款方式强制落空；全额/部分收款才记方式
    const methodForTx = isCredit && paidAmount === 0 ? null : payMethod
    let paidLeft = isCredit ? paidAmount : 0
    const resultLines = []
    for (const { line: l, batches } of planRows) {
      let remaining = l.quantity
      const allocations = []
      for (const b of batches) {
        if (remaining <= 0) break
        const deduct = Math.min(b.quantity, remaining)
        db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?').run(b.quantity - deduct, b.id)
        // 实收按行顺序 + 行内 FIFO 摊销到每条流水；未覆盖到的记 0（赊的那段）
        let paid = null
        if (isCredit) {
          paid = Math.min(deduct * l.sellingPrice, paidLeft)
          paidLeft -= paid
        }
        db.prepare(
          `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount, pay_method)
           VALUES (?, ?, 'out', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        ).run(l.productId, b.id, deduct, b.cost_price, l.sellingPrice, ts, operator ?? null, customerId ?? null, paid, methodForTx)
        allocations.push({ batch_id: b.id, batch_no: b.batch_no, deduct, remaining_after: b.quantity - deduct, cost_price: b.cost_price })
        remaining -= deduct
      }
      resultLines.push({ productId: l.productId, quantity: l.quantity, sellingPrice: l.sellingPrice, allocations })
    }
    const names = resultLines
      .map((rl) => {
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(rl.productId)
        return `${p ? productLabel(p) : `#${rl.productId}`} x${rl.quantity}`
      })
      .join('，')
    logAudit(
      db,
      '收银开单',
      `${resultLines.length} 种商品：${names}`,
      { itemCount: resultLines.length, totalDue, paidAmount: isCredit ? paidAmount : null, creditAmount: isCredit ? totalDue - paidAmount : 0, customerId: customerId ?? null },
      operator,
    )
    return {
      ok: true,
      lines: resultLines,
      totalDue,
      paidAmount: isCredit ? paidAmount : null,
      creditAmount: isCredit ? totalDue - paidAmount : 0,
    }
  })
}

/**
 * 退货登记：顾客退回来的货重新入架。
 * 库存加回最近一次入库的批次（成本口径一致，FIFO 队列不被退货打乱）；
 * 该商品没有任何批次时新建一条"退货回补"批次，成本取商品最近进价。
 * 流水 type='return'：unit_price=批次成本，selling_price=退款金额（分），
 * 退款记 selling_price 让"今日经营小结"能把退货从营业额里体现出来。
 *
 * 赊账口径（重要）：如果当初那笔出库是赊账卖的，退货要冲减客户欠款——
 * 前端传 customerId，退货流水记 customer_id、paid_amount 记 NULL，
 * 欠款计算时 return 类型按 quantity*selling_price 以负数计入该客户的赊销合计。
 * 已全额收款的退货不要传 customerId（退的是现金，与赊账余额无关）。
 * 退款方式扩展：payMethod 可选（现金/微信/支付宝/其他）。只有真退钱（不传 customerId）才落库；
 * 冲减欠款的退货没有现金移动，pay_method 强制记 NULL。
 */
export function createReturn(db, { productId, quantity: rawQuantity, refundPrice, operator, customerId, payMethod }) {
  // 计量单位：米商品（鱼线）允许小数退货
  const prod0 = db.prepare('SELECT unit FROM products WHERE id = ?').get(productId)
  if (!prod0) throw new Error('商品不存在')
  const quantity = assertQuantity(rawQuantity, '退货数量', prod0.unit === '米' ? '米' : '件')
  if (refundPrice != null) assertFen(refundPrice, '退款金额')
  payMethod = assertPayMethod(payMethod, '退款方式')
  return inTransaction(db, () => {
    if (customerId != null) {
      const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)
      if (!cust) throw new Error('客户不存在')
    }
    const ts = now()
    const { batchId, unitCost } = addBackToLatestBatch(db, productId, quantity)
    db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount, pay_method)
       VALUES (?, ?, 'return', ?, ?, ?, ?, ?, '退货回补', ?, NULL, ?)`,
    ).run(productId, batchId, quantity, unitCost, refundPrice ?? null, ts, operator ?? null, customerId ?? null, customerId == null ? payMethod : null)
    const retProd = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    logAudit(db, '退货', `${retProd ? productLabel(retProd) : `#${productId}`} x${quantity}`,
      { quantity, refundPrice: refundPrice ?? null, customerId: customerId ?? null }, operator)
    return { ok: true, batchId }
  })
}

/**
 * 换货登记：先退旧货再出新货，同一事务，任一环节失败整体回滚。
 * 记账口径（重要）：退旧腿记 type='return'（notes='换货退旧'），出新腿记 type='out'
 * （notes='换货出新'，unit_price=批次成本，selling_price=新货售价）——
 * 与退货/正常出库同类型，全站的今日记录、营业额、毛利、趋势统计自动涵盖换货，
 * 不需要每个报表单独识别 exchange 类型。
 * 新货库存不足时不落任何写入，返回 shortage。
 *
 * 差价扩展（customerId / diffPaidAmount 均可空）：
 * - 差价 diff = 新腿售价合计 - 旧腿原售价合计；旧腿原售价取该商品最近一条带售价的出库流水，
 *   找不到回退商品建议零售价，都没有按 0 并在返回 oldPriceSource='none' 标注。
 * - diff > 0（客户补钱）：diffPaidAmount 省略=差价全额付清（新腿流水 paid_amount 保持 NULL）；
 *   部分付/0=差价赊账（必须传 customerId，否则报"赊账必须选客户"，口径照 confirmOutbound）。
 *   赊账时新腿流水记 customer_id + paid_amount（按 FIFO 分摊：旧货价值视为已付，
 *   即 Σpaid = 新腿应付 - 赊欠差额），返回值带 {diff, diffPaid, diffCredit}。
 * - diff < 0（退钱给客户）：记一条 type='exchange' 数量为正的流水，paid_amount 记负退款额、
 *   notes 标注"换货退差价"；若原购买是赊账且未付清（旧腿原流水有 customer_id 且有未付部分），
 *   优先冲减该客户欠款（exchange 流水记原 customer_id，欠款口径见 netCreditOf），
 *   否则退现金（customer_id 记 NULL）；返回值 refundHandling 说明实际处理方式。
 */
export function createExchange(db, { oldProductId, newProductId, quantity: rawQuantity, sellingPrice, operator, customerId, diffPaidAmount }) {
  // 计量单位：按新货（出库那条腿）的单位校验，米商品允许小数
  const newProd0 = db.prepare('SELECT unit FROM products WHERE id = ?').get(newProductId)
  if (!newProd0) throw new Error('商品不存在')
  const quantity = assertQuantity(rawQuantity, '换货数量', newProd0.unit === '米' ? '米' : '件')
  if (sellingPrice != null) assertFen(sellingPrice, '换货售价')
  if (diffPaidAmount != null) assertFen(diffPaidAmount, '差价实收')
  return inTransaction(db, () => {
    if (customerId != null) {
      const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)
      if (!cust) throw new Error('客户不存在')
    }
    // 先验新货库存，不够直接拒绝（尚未写入，事务提交等于空操作）
    const newBatches = db
      .prepare(
        `SELECT * FROM inventory_batches
         WHERE product_id = ? AND quantity > 0
         ORDER BY
           CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
           expiry_date ASC,
           inbound_date ASC,
           id ASC`,
      )
      .all(newProductId)
    const total = newBatches.reduce((s, b) => s + b.quantity, 0)
    if (total < quantity) return { ok: false, shortage: quantity - total }

    // 旧腿原售价：最近一条带售价的出库流水 → 建议零售价 → 0（标注来源）
    const oldTx = db
      .prepare(
        `SELECT selling_price, customer_id, paid_amount, quantity FROM transactions
         WHERE product_id = ? AND type = 'out' AND selling_price IS NOT NULL
         ORDER BY timestamp DESC, id DESC LIMIT 1`,
      )
      .get(oldProductId)
    let oldUnitPrice
    let oldPriceSource
    if (oldTx) {
      oldUnitPrice = oldTx.selling_price
      oldPriceSource = 'transaction'
    } else {
      const prod = db.prepare('SELECT suggest_price FROM products WHERE id = ?').get(oldProductId)
      if (prod?.suggest_price != null) {
        oldUnitPrice = prod.suggest_price
        oldPriceSource = 'suggest'
      } else {
        oldUnitPrice = 0
        oldPriceSource = 'none'
      }
    }
    const oldTotal = oldUnitPrice * quantity
    const newTotal = sellingPrice != null ? sellingPrice * quantity : null
    const diff = newTotal != null ? newTotal - oldTotal : null

    // 差价实收校验（口径照 confirmOutbound：省略=全额付清；部分付/0=赊账，必须选客户）
    let diffPaid = null
    if (diffPaidAmount != null) {
      if (diff == null) throw new Error('记差价实收时必须填写新货售价')
      if (diff <= 0) {
        if (diffPaidAmount > 0) throw new Error('新货价格不高于旧货，无差价可收（应退差价）')
      } else {
        if (diffPaidAmount > diff) {
          throw new Error(`差价实收不能超过差价（差价 ${diff} 分，实收 ${diffPaidAmount} 分）`)
        }
        if (diffPaidAmount < diff && customerId == null) throw new Error('赊账必须选客户')
        diffPaid = diffPaidAmount
      }
    }
    // 本次换货的差价赊欠额（>0 才走赊账分摊）
    const diffCredit = diff != null && diff > 0 && diffPaid != null && diffPaid < diff ? diff - diffPaid : 0

    const ts = now()
    // 退旧：回补最近批次，按退货类型记账
    const back = addBackToLatestBatch(db, oldProductId, quantity)
    db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes)
       VALUES (?, ?, 'return', ?, ?, NULL, ?, ?, '换货退旧')`,
    ).run(oldProductId, back.batchId, quantity, back.unitCost, ts, operator ?? null)

    // 出新：FIFO 扣减，按正常出库类型记账（营业额/毛利统计自动涵盖）
    // 差价赊账时：旧货价值视为已付，实收分摊基数 = 新腿应付 - 赊欠差额，按 FIFO 顺序分摊
    let paidLeft = diffCredit > 0 ? newTotal - diffCredit : 0
    let remaining = quantity
    for (const b of newBatches) {
      if (remaining <= 0) break
      const deduct = Math.min(b.quantity, remaining)
      db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?').run(b.quantity - deduct, b.id)
      let paid = null
      if (diffCredit > 0) {
        paid = Math.min(deduct * sellingPrice, paidLeft)
        paidLeft -= paid
      }
      db.prepare(
        `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?, '换货出新', ?, ?)`,
      ).run(newProductId, b.id, deduct, b.cost_price, sellingPrice ?? null, ts, operator ?? null, customerId ?? null, paid)
      remaining -= deduct
    }

    const result = {
      ok: true,
      diff,
      diffPaid: diff == null ? null : diff > 0 ? (diffPaid ?? diff) : 0,
      diffCredit,
      oldUnitPrice,
      oldPriceSource,
    }

    // 退差价：退款 = -diff；原购买赊账未付清 → 冲减欠款，否则退现金
    if (diff != null && diff < 0) {
      const refund = -diff
      const oldUnpaid =
        oldTx && oldTx.customer_id != null
          ? oldTx.quantity * oldTx.selling_price -
            (oldTx.paid_amount ?? oldTx.quantity * oldTx.selling_price)
          : 0
      const offset = oldUnpaid > 0
      db.prepare(
        `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount)
         VALUES (?, NULL, 'exchange', ?, NULL, NULL, ?, ?, '换货退差价', ?, ?)`,
      ).run(oldProductId, quantity, ts, operator ?? null, offset ? oldTx.customer_id : null, -refund)
      result.refund = refund
      result.refundHandling = offset ? 'credit_offset' : 'cash'
      if (offset) result.refundCustomerId = oldTx.customer_id
    }
    const oldProd = db.prepare('SELECT * FROM products WHERE id = ?').get(oldProductId)
    const newProd = db.prepare('SELECT * FROM products WHERE id = ?').get(newProductId)
    logAudit(db, '换货',
      `${oldProd ? productLabel(oldProd) : `#${oldProductId}`} → ${newProd ? productLabel(newProd) : `#${newProductId}`} x${quantity}`,
      { quantity, diff, diffCredit, customerId: customerId ?? null }, operator)
    return result
  })
}
