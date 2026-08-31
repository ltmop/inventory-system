import { useState } from 'react'
import { Bot, CircleHelp, Copy, ExternalLink, Keyboard, MessageCircleQuestion, Smartphone, Terminal, Truck } from 'lucide-react'
import { PageHeader } from '@/components/feedback'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const QUICK_STEPS: { title: string; steps: string[] }[] = [
  {
    title: '第一次开店怎么开始？',
    steps: [
      '点左边「扫码入库」，用扫码枪扫第一个商品的条码（没有条码就点「手动建档」填名字）。',
      '填进价、售价、数量，点「确认入库」——货就进系统了。',
      '多进几个货，以后卖货直接「销售出库」，扫码枪一扫就扣库存。',
    ],
  },
  {
    title: '手机怎么开单卖货？',
    steps: [
      '设置页「手机看店」二维码，手机扫一下进入（第一次要点「高级→继续访问」信任证书）。',
      '点「开单」，扫码或搜商品，选好数量点收款方式就卖出去了。',
      '手机端和电脑是同一套数据，实时同步。',
    ],
  },
  {
    title: '怎么让 AI 帮忙查货/补货？',
    steps: [
      '设置页「AI 助手」填一个模型的 API Key（Kimi/豆包/DeepSeek 都行），保存验证。',
      '点仪表盘右下角的「小渔」聊天框，问它"伊势尼还剩多少""该补什么货"。',
      '开了「小杜语音助手」后，直接喊"小杜小杜"说话问。',
    ],
  },
]

const FAQ: { q: string; a: string }[] = [
  { q: '扫码枪插上没反应？', a: 'USB 扫码枪即插即用，扫一下会自动输入并回车。检查是否插对 USB 口、系统是否识别（插上后扫一下看光标处有没有出现条码）。' },
  { q: '手机打不开 / 白屏？', a: '手机要和电脑连同一个 WiFi。第一次用 https 会提示"连接不是私密连接"，点「高级」→「继续访问」。如果还不行，检查电脑防火墙是否放行了这个软件。' },
  { q: '语音识别不准 / 不能用？', a: '手机语音需要 https（见上一条）。电脑语音要在设置页下载「语音识别模型」（约228MB）和「唤醒词模型」（约5MB）。识别不准时，说商品名会先用店里清单纠正。' },
  { q: '进货单拍照识别不出来？', a: '拍送货单时：纸要铺平、光线要足、别折角反光。识别后会逐行给你核对数量价格，改完再入库。识别不出来就手动建档。' },
  { q: '数据会不会丢？', a: '系统每天凌晨 3 点自动备份，关软件时也备份。建议在设置页「备份」里配一个 U 盘作为第二备份位置，双保险。' },
  { q: '换电脑了数据怎么搬？', a: '设置页「备份」→ 备份现在的数据，把备份文件拷到新电脑，用「从备份恢复」还原。进阶版有云端备份更省事。' },
  { q: '微信/支付宝收的钱怎么对账？', a: '手机开单选微信/支付宝时会展示收款码让顾客扫，到账后点完成。每天看「今日」页的收款明细，和你的微信/支付宝钱包核对。' },
]

/** 帮助中心：核心操作步骤 + 常见问题（40岁+老板自助用） */
export function HelpPage() {
  // CLI 命令一键复制 + 官网一键打开（2026-09-01：从纯文字说明变成可操作入口）
  const [copied, setCopied] = useState(false)
  const copyCli = async () => {
    try {
      await navigator.clipboard.writeText('node scripts/inv.mjs help')
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* 剪贴板不可用忽略 */ }
  }
  const openSite = (url: string) => {
    const w = window.open(url, '_blank')
    if (!w) window.location.href = url
  }
  return (
    <div className="space-y-4">
      <PageHeader title="帮助中心" subtitle="第一次用？从这里开始；卡住了先看常见问题" />

      {/* 快速上手步骤 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {QUICK_STEPS.map((s, i) => (
          <Card key={i}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {i === 0 && <Truck className="size-5 text-brand-500" />}
                {i === 1 && <Smartphone className="size-5 text-brand-500" />}
                {i === 2 && <CircleHelp className="size-5 text-brand-500" />}
                {s.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {s.steps.map((step, j) => (
                <div key={j} className="flex gap-2 text-sm">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">{j + 1}</span>
                  <span className="leading-relaxed text-slate-700">{step}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 扫码枪快捷键 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Keyboard className="size-5 text-brand-500" />
            扫码枪 & 快捷键
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 text-sm text-slate-700 md:grid-cols-2">
          <div>· <b>扫码枪</b>：插上即用，扫条码自动输入并回车（在入库/出库页）</div>
          <div>· <b>语音</b>：开小杜助手后喊"小杜小杜"说话</div>
          <div>· <b>手机</b>：连店里 WiFi 扫设置页二维码</div>
          <div>· <b>拍照</b>：入库页「AI 拍照建档」拍送货单自动识别</div>
        </CardContent>
      </Card>

      {/* 开发者与 AI 接入 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="size-5 text-brand-500" />
            开发者与 AI 接入
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-slate-700">
          <div>
            <b>命令行 CLI（多机同步/备份）</b>：在系统目录打开命令行，运行
            <code className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs">node scripts/inv.mjs help</code>
            查看全部命令（config / register / login / status / sync / backup / backups / restore / devices）
            <button
              onClick={copyCli}
              className="ml-2 inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-brand-700 hover:bg-slate-200 cursor-pointer"
            >
              <Copy className="size-3" />
              {copied ? '已复制' : '复制命令'}
            </button>
          </div>
          <div>
            <b>Agent / 数据分析接入</b>：局域网 HTTP 接口（设置页「手机看店」里的网址 + 自动生成的访问令牌），
            支持查询今日经营、库存、对账与常用操作。完整接口见 <code className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs">docs/进销存数据分析接口.md</code> 与 <code className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs">docs/进销存系统Agent接入指南.md</code>
          </div>
          <div className="flex items-start gap-2">
            <Bot className="mt-0.5 size-4 shrink-0 text-brand-500" />
            <span><b>开发改造 Skill</b>：系统的开发/改造/打包技能包（inventory-system-dev）与 CLI 工具、接口文档，均可在官网文档站下载：
              <button
                onClick={() => openSite('https://junchengzn.com/docs')}
                className="ml-1 inline-flex items-center gap-1 font-bold text-brand-600 underline hover:text-brand-700 cursor-pointer"
              >
                打开官网文档站 <ExternalLink className="size-3.5" />
              </button>
            </span>
          </div>
        </CardContent>
      </Card>

      {/* 常见问题 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircleQuestion className="size-5 text-brand-500" />
            常见问题
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {FAQ.map((f, i) => (
            <div key={i}>
              <div className="font-medium text-slate-800">{f.q}</div>
              <div className="mt-1 text-sm leading-relaxed text-slate-600">{f.a}</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
