// 资金账户卡片（最小形态，2026-09-22）——「钱在哪、收了多少、付了多少、还剩多少」
//
// 口径：一份推导在 src/lib/moneyAccounts.ts（与 electron/lib/moneyAccounts.js 是同口径双胞胎）。
// 账户 = 收款方式（现金/微信/支付宝/其他）——**不新增账户概念**，就是现有 pay_method 的取值域；
// 余额 = 期初 + Σ收 − Σ付。钱从四处已有记录里来：
//   出库实收 / 退货退款（transactions）、客户还款（payments）、支出（expenses）、付供应商（supplierPayments）。
//
// 为什么桌面端要自己算而不是调服务端通道：
//   本机模式（没连中心库）下没有任何服务端通道可调；而这个项目的既有做法就是"界面从 store 现算"。
//   期初跟着 loadAll 下发（见 electron/commands/catalog.js），所以两种模式取到的是同一份期初。
import { useMemo } from 'react'
import { Wallet } from 'lucide-react'

import { useAppStore } from '@/store/appStore'
import { formatPrice } from '@/lib/formatters'
import { deriveMoneyAccounts } from '@/lib/moneyAccounts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function MoneyAccountsCard() {
  const transactions = useAppStore((s) => s.transactions)
  const payments = useAppStore((s) => s.payments)
  const supplierPayments = useAppStore((s) => s.supplierPayments)
  const expenses = useAppStore((s) => s.expenses)
  const opening = useAppStore((s) => s.accountOpening)

  const view = useMemo(
    () => deriveMoneyAccounts({ transactions, payments, supplierPayments, expenses, opening }, {}),
    [transactions, payments, supplierPayments, expenses, opening],
  )

  const { accounts, totals, unrecorded } = view
  const hasAny = totals.n > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="size-5 text-brand-500" />
          资金账户
        </CardTitle>
        <CardDescription>
          按「收款方式」看钱的进出：账户 = 现金 / 微信 / 支付宝 / 其他，余额 = 期初 + 收 − 付。
          卖货实收、退货退款、客户还款、支出、付供应商都算在内；没记收款方式的那部分单列在下面，不摊到任何账户头上。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账户</TableHead>
              <TableHead className="text-right">期初</TableHead>
              <TableHead className="text-right">收</TableHead>
              <TableHead className="text-right">付</TableHead>
              <TableHead className="text-right">余额</TableHead>
              <TableHead className="text-right">笔数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a.account}>
                <TableCell className="font-medium">{a.account}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {a.openingFen ? formatPrice(a.openingFen) : '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums text-green-700">
                  {a.inFen ? formatPrice(a.inFen) : '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums text-red-600">
                  {a.outFen ? formatPrice(a.outFen) : '—'}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatPrice(a.closingFen)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{a.n || '—'}</TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/40">
              <TableCell className="font-semibold">合计</TableCell>
              <TableCell className="text-right tabular-nums">{formatPrice(totals.openingFen)}</TableCell>
              <TableCell className="text-right font-semibold tabular-nums text-green-700">
                {formatPrice(totals.inFen)}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums text-red-600">
                {formatPrice(totals.outFen)}
              </TableCell>
              <TableCell className="text-right font-bold tabular-nums">{formatPrice(totals.closingFen)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{totals.n}</TableCell>
            </TableRow>
          </TableBody>
        </Table>

        {unrecorded.n > 0 && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
            还有 <span className="font-semibold">{unrecorded.n}</span> 笔钱没记收款方式（收{' '}
            {formatPrice(unrecorded.inFen)} / 付 {formatPrice(unrecorded.outFen)}）—— 这部分不计进任何账户。
            在开单/支出/还款时选上收款方式，账才会越记越准。
          </div>
        )}

        {!hasAny && (
          <div className="text-sm text-muted-foreground">
            还没有带收款方式的进出记录。开单时选「现金/微信/支付宝」，或在支出页记一笔，这里就会开始有数。
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          口径：只统计有售价的出库/退货（渠道发货这类不碰钱的流水不算）；出库实收取「实收金额」，老数据没记的按「售价 × 数量」算全额。
          期初余额存在库里（设置表 account_opening），目前还没有录入入口，默认按 0 算。
        </div>
      </CardContent>
    </Card>
  )
}
