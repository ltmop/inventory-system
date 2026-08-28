import { useState } from 'react'
import { motion } from 'motion/react'
import type { Box } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { useCountUp } from '@/lib/useCountUp'

export interface CardSpec {
  title: string
  value: number
  format: (v: number) => string
  unit: string
  icon: typeof Box
  cardClass: string
  iconClass: string
  numClass: string
  pulse?: boolean
  /** 点击跳转/动作：预警卡片必须能点进去处理，否则预警形同虚设 */
  action?: () => void
  actionHint?: string
  /** 主打卡片：占两列、数字更大（库存总值） */
  featured?: boolean
}

/** 仪表盘统计卡：数字滚动 + 悬浮上浮 + Aceternity 光晕跟随 + 可点击跳转 */
export function StatCard({ spec, index }: { spec: CardSpec; index: number }) {
  const animated = useCountUp(spec.value)
  const Icon = spec.icon
  const [spot, setSpot] = useState({ x: 0, y: 0 })
  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setSpot({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05, ease: 'easeOut' }}
      whileHover={{ y: -3 }}
      className={spec.featured ? 'col-span-2' : ''}
    >
      <Card
        onMouseMove={handleMove}
        onClick={spec.action}
        onKeyDown={
          spec.action
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  spec.action!()
                }
              }
            : undefined
        }
        role={spec.action ? 'button' : undefined}
        tabIndex={spec.action ? 0 : undefined}
        className={`group relative h-full overflow-hidden shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover ${
          spec.featured ? 'hover:shadow-brand-900/20' : ''
        } ${spec.cardClass} ${
          spec.pulse ? 'animate-pulse' : ''
        } ${spec.action ? 'cursor-pointer focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none' : ''}`}
      >
        {/* Aceternity 光晕跟随：鼠标滑过时泛起柔和光斑 */}
        <div
          className="pointer-events-none absolute inset-0 z-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{
            background: `radial-gradient(260px circle at ${spot.x}px ${spot.y}px, ${
              spec.featured ? 'rgba(255,255,255,0.18)' : 'rgba(37,99,235,0.10)'
            }, transparent 65%)`,
          }}
        />
        <CardContent className={`relative z-10 ${spec.featured ? 'flex h-full items-center gap-5 pt-6' : 'pt-6'}`}>
          <div className={`inline-flex rounded-full p-2.5 transition-transform duration-200 group-hover:scale-110 ${spec.iconClass} ${spec.featured ? 'mb-0 p-3.5' : 'mb-3'}`}>
            <Icon className={spec.featured ? 'size-7' : 'size-5'} />
          </div>
          <div>
            <div className={`text-xs ${spec.featured ? 'text-white/70 dark:text-[#0a1628]/80' : 'text-slate-500'}`}>{spec.title}</div>
            <div
              className={`font-bold leading-tight tabular-nums ${spec.numClass} ${
                spec.featured ? 'text-[36px]' : 'text-[28px]'
              }`}
            >
              {spec.format(animated)}
            </div>
            <div className={`text-xs ${spec.featured ? 'text-white/60 dark:text-[#0a1628]/70' : 'text-slate-400'}`}>
              {spec.unit}
              {spec.actionHint && (
                <span className={spec.featured ? 'ml-1 text-white/80 dark:text-[#0a1628]' : 'ml-1 text-brand-500 dark:text-gold-400'}>
                  {spec.actionHint} →
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
