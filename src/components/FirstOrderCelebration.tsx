// M4 动效：首单庆祝彩带。盘点完成后首次开单成功 → 撒彩带 + 「第一单」提示（只触发一次/会话）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { useAppStore } from '@/store/appStore'

const COLORS = ['#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#38bdf8', '#34d399', '#f472b6']
const N = 46

function ConfettiBurst() {
  const pieces = useMemo(
    () =>
      Array.from({ length: N }, (_, i) => ({
        id: i,
        x: (Math.random() - 0.5) * 90,        // vw 偏移（绕中轴散开）
        delay: Math.random() * 0.5,
        duration: 2.2 + Math.random() * 1.4,
        color: COLORS[i % COLORS.length],
        size: 6 + Math.random() * 8,
        rotate: Math.random() * 360,
      })),
    [],
  )
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden">
      {pieces.map((p) => (
        <motion.div
          key={p.id}
          initial={{ y: '-12vh', x: '50vw', rotate: p.rotate, opacity: 1 }}
          animate={{ y: '112vh', x: `calc(50vw + ${p.x}vw)`, rotate: p.rotate + 720, opacity: [1, 1, 0.5, 0] }}
          transition={{ duration: p.duration, delay: p.delay, ease: 'easeIn' }}
          className="absolute"
          style={{ width: p.size, height: p.size * 0.6, background: p.color, borderRadius: 2 }}
        />
      ))}
    </div>
  )
}

export function FirstOrderCelebration() {
  const transactions = useAppStore((s) => s.transactions)
  const [fire, setFire] = useState(false)
  const initialOuts = useRef<number | null>(null)
  const fired = useRef(false)

  // 某次出库（开单）后交易数有新增 → 首次触发彩带（一次/会话）
  useEffect(() => {
    const outs = transactions.filter((t) => t.type === 'out').length
    if (initialOuts.current === null) {
      initialOuts.current = outs
      return
    }
    if (outs > initialOuts.current && !fired.current) {
      fired.current = true
      setFire(true)
      const t = setTimeout(() => setFire(false), 3400)
      return () => clearTimeout(t)
    }
  }, [transactions])

  if (!fire) return null
  return (
    <>
      <ConfettiBurst />
      {/* 居中「首单」达成提示 */}
      <motion.div
        initial={{ opacity: 0, scale: 0.7, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 18 }}
        className="pointer-events-none fixed inset-0 z-[61] flex items-center justify-center"
      >
        <div className="rounded-2xl border border-amber-200/70 bg-white/90 px-8 py-6 text-center shadow-2xl backdrop-blur">
          <div className="text-3xl">🎉</div>
          <div className="mt-2 text-xl font-bold text-slate-800">第一单到手！</div>
          <div className="mt-1 text-sm text-slate-500">继续加油，生意兴隆</div>
        </div>
      </motion.div>
    </>
  )
}
