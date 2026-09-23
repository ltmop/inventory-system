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
import { useMemo, useState } from 'react'
import { SlidersHorizontal, Wallet } from 'lucide-react'

import { useAppStore } from '@/store/appStore'
import { backend } from '@/lib/api'
import { formatPrice } from '@/lib/formatters'
import { deriveMoneyAccounts } from '@/lib/moneyAccounts'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

  const loadAll = useAppStore((s) => s.loadAll)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  /** 期初录入：四个账户各一个输入框，单位「元」，空 = 0 */
  const openDialog = () => {
    const next: Record<string, string> = {}
    for (const a of accounts) next[a.account] = a.openingFen ? (a.openingFen / 100).toFixed(2) : ''
    setForm(next)
    setMsg('')
    setOpen(true)
  }

  const save = async () => {
    if (!backend) {
      setMsg('没有可用的后端连接，存不了')
      return
    }
    setBusy(true)
    setMsg('')
    try {
      for (const a of accounts) {
        const raw = (form[a.account] ?? '').trim()
        const yuan = raw === '' ? 0 : Number(raw)
        if (!Number.isFinite(yuan) || yuan < 0) throw new Error(`${a.account} 的金额不对：${raw}`)
        const fen = Math.round(yuan * 100)
        // 只提交真的改了的账户：少一次写、也少一条审计噪音
        if (fen !== a.openingFen) await backend.invoke('fund:setOpening', { account: a.account, amountFen: fen })
      }
      await loadAll()
      setOpen(false)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="size-5 text-brand-500" />
          资金账户
          <Button variant="outline" size="sm" className="ml-auto" onClick={openDialog}>
            <SlidersHorizontal className="size-3.5" />
            设置期初
          </Button>
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
          期初余额存在库里（设置表 account_opening），没设就按 0 算。
        </div>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>设置期初余额</DialogTitle>
            <DialogDescription>
              填「开始用这套账本时，每个账户里本来有多少钱」（单位：元）。填对一次，余额从此才准；
              不填就当 0。留空或填 0 都是清掉这一项。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {accounts.map((a) => (
              <div key={a.account} className="flex items-center gap-3">
                <Label className="w-16 shrink-0">{a.account}</Label>
                <Input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={form[a.account] ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, [a.account]: e.target.value }))}
                />
                <span className="w-10 shrink-0 text-xs text-muted-foreground">元</span>
              </div>
            ))}
            {msg && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{msg}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
