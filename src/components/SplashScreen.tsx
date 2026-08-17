// 启动画面：大鱼上钩动画，数据加载完成后播一次，播完（或点击/减弱动画）才进主界面
// 纯 SVG + motion，无图片资源；只用 transform/opacity，全程约 2.5 秒
import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'

/** 动画剧本（秒）：0.15 鱼线垂下 → 0.72 绷紧抖动 → 0.9 大鱼出水+水花 → 1.35 店名定格 → 2.05 整体上滑退出 */
const EXIT_AT_MS = 2050

/** 一条侧面朝左的大鱼：身体/尾巴/背鳍/胸鳍/眼睛/鳃线，局部坐标原点在鱼身中心 */
function Fish() {
  return (
    <g>
      {/* 尾巴：绕根部左右摆，fill-box 让旋转轴在尾巴自己的连接端 */}
      <motion.g
        style={{ transformBox: 'fill-box', transformOrigin: 'left center' }}
        animate={{ rotate: [-7, 7, -7] }}
        transition={{ duration: 0.5, repeat: Infinity, ease: 'easeInOut' }}
      >
        <path
          d="M 52 0 L 96 -30 C 86 -12 86 12 96 30 Z"
          fill="#3f6db3"
          stroke="#2c4f88"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </motion.g>
      {/* 背鳍 */}
      <path
        d="M -24 -30 C -10 -54 26 -52 42 -28 C 18 -36 -4 -36 -24 -30 Z"
        fill="#3f6db3"
        stroke="#2c4f88"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 鱼身：银蓝渐变，头左尾右 */}
      <path
        d="M -82 0 C -64 -36 16 -44 52 -18 C 66 -8 68 8 52 18 C 16 44 -64 36 -82 0 Z"
        fill="url(#fishBody)"
        stroke="#2c4f88"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* 腹部高光 */}
      <path
        d="M -70 10 C -40 26 10 28 44 12 C 10 34 -44 32 -70 10 Z"
        fill="#dcebf7"
        opacity="0.75"
      />
      {/* 胸鳍 */}
      <motion.path
        d="M -40 8 C -26 10 -18 22 -21 34 C -35 28 -42 18 -40 8 Z"
        fill="#4f7fc4"
        stroke="#2c4f88"
        strokeWidth="1.5"
        strokeLinejoin="round"
        style={{ transformBox: 'fill-box', transformOrigin: 'top center' }}
        animate={{ rotate: [0, 10, 0] }}
        transition={{ duration: 0.6, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* 鳃线 */}
      <path
        d="M -44 -20 C -34 -8 -34 8 -44 20"
        fill="none"
        stroke="#2c4f88"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* 眼睛 */}
      <circle cx="-56" cy="-8" r="6" fill="#ffffff" stroke="#2c4f88" strokeWidth="1.5" />
      <circle cx="-57.5" cy="-8" r="2.8" fill="#12263f" />
      {/* 嘴 */}
      <path d="M -82 0 C -78 2 -76 3 -72 3" fill="none" stroke="#2c4f88" strokeWidth="2" strokeLinecap="round" />
    </g>
  )
}

/** 水花粒子：鱼出水瞬间从水面向上溅起再落下淡出 */
function SplashDrops() {
  const drops = [
    { x: -34, peak: -52, drift: -30, size: 5, delay: 0 },
    { x: 0, peak: -68, drift: 6, size: 6, delay: 0.04 },
    { x: 36, peak: -46, drift: 34, size: 4.5, delay: 0.02 },
  ]
  return (
    <g>
      {drops.map((d, i) => (
        <motion.circle
          key={i}
          cx={400 + d.x}
          cy={418}
          r={d.size}
          fill="#cfe6fb"
          initial={{ opacity: 0, x: 0, y: 0 }}
          animate={{ opacity: [0, 1, 0], x: [0, d.drift * 0.6, d.drift], y: [0, d.peak, 12] }}
          transition={{ delay: 0.92 + d.delay, duration: 0.6, ease: 'easeOut' }}
        />
      ))}
      {/* 水面涟漪：两圈椭圆扩散 */}
      {[0, 0.12].map((d, i) => (
        <motion.ellipse
          key={i}
          cx={400}
          cy={420}
          rx={30}
          ry={6}
          fill="none"
          stroke="#9cc8ee"
          strokeWidth="2.5"
          initial={{ opacity: 0, scaleX: 0.4, scaleY: 0.4 }}
          animate={{ opacity: [0, 0.9, 0], scaleX: [0.4, 1.6, 2.4], scaleY: [0.4, 1.6, 2.4] }}
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          transition={{ delay: 0.95 + d, duration: 0.8, ease: 'easeOut' }}
        />
      ))}
    </g>
  )
}

export function SplashScreen({ onFinish }: { onFinish: () => void }) {
  const reducedMotion = useReducedMotion()
  const [exiting, setExiting] = useState(false)

  // 系统开了减弱动画：直接跳过，一帧都不播
  useEffect(() => {
    if (reducedMotion) onFinish()
  }, [reducedMotion, onFinish])

  // 定格半秒后整体上滑退出
  useEffect(() => {
    const t = setTimeout(() => setExiting(true), EXIT_AT_MS)
    return () => clearTimeout(t)
  }, [])

  if (reducedMotion) return null

  return (
    <motion.div
      role="button"
      aria-label="跳过启动动画"
      onClick={() => setExiting(true)}
      initial={false}
      animate={exiting ? { y: '-100%', opacity: 0.4 } : { y: 0, opacity: 1 }}
      transition={{ duration: 0.45, ease: 'easeIn' }}
      onAnimationComplete={() => {
        if (exiting) onFinish()
      }}
      className="fixed inset-0 z-[100] cursor-pointer overflow-hidden bg-gradient-to-b from-[#0a1f3d] via-[#10315e] to-[#0a2547]"
    >
      <svg viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
        <defs>
          <linearGradient id="fishBody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7fa8d9" />
            <stop offset="55%" stopColor="#5b87c2" />
            <stop offset="100%" stopColor="#3f6db3" />
          </linearGradient>
          <linearGradient id="waterBody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1c4e8a" />
            <stop offset="100%" stopColor="#0a2547" />
          </linearGradient>
        </defs>

        {/* 鱼线 + 大鱼：同组一起上升；鱼线先从上方垂下，绷紧时抖一下，随后大鱼被拉出水面 */}
        <motion.g
          initial={{ x: 400, y: 500, rotate: 0 }}
          animate={{ y: 330, x: [400, 404, 397, 400], rotate: [0, -16, 7, 0] }}
          transition={{
            y: { delay: 0.9, type: 'spring', stiffness: 110, damping: 13 },
            x: { delay: 0.72, duration: 0.22 },
            rotate: { delay: 0.9, duration: 0.7, ease: 'easeOut' },
          }}
        >
          <motion.line
            x1="-70"
            y1="-520"
            x2="-70"
            y2="-4"
            stroke="#d7e6f5"
            strokeWidth="2"
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            style={{ transformBox: 'fill-box', transformOrigin: 'center top' }}
            transition={{ delay: 0.15, duration: 0.45, ease: 'easeIn' }}
          />
          <Fish />
        </motion.g>

        {/* 水花与涟漪（鱼出水瞬间） */}
        <SplashDrops />

        {/* 水体：盖住水面以下的鱼，出水时才露出 */}
        <rect x="0" y="420" width="800" height="180" fill="url(#waterBody)" />
        {/* 两层波浪：反向漂移 + 轻轻起伏 */}
        <motion.path
          d="M -200 420 Q -150 406 -100 420 T 0 420 T 100 420 T 200 420 T 300 420 T 400 420 T 500 420 T 600 420 T 700 420 T 800 420 T 900 420 T 1000 420 L 1000 440 L -200 440 Z"
          fill="#2a5f9e"
          opacity="0.9"
          animate={{ x: [0, -200], y: [0, 3, 0] }}
          transition={{
            x: { duration: 5, repeat: Infinity, ease: 'linear' },
            y: { duration: 2.4, repeat: Infinity, ease: 'easeInOut' },
          }}
        />
        <motion.path
          d="M -200 426 Q -150 414 -100 426 T 0 426 T 100 426 T 200 426 T 300 426 T 400 426 T 500 426 T 600 426 T 700 426 T 800 426 T 900 426 T 1000 426 L 1000 448 L -200 448 Z"
          fill="#1c4e8a"
          animate={{ x: [-200, 0], y: [0, -3, 0] }}
          transition={{
            x: { duration: 6.5, repeat: Infinity, ease: 'linear' },
            y: { duration: 3, repeat: Infinity, ease: 'easeInOut' },
          }}
        />
      </svg>

      {/* 店名：鱼出水后定格亮出 */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.35, duration: 0.4, ease: 'easeOut' }}
        className="absolute inset-x-0 top-[16%] text-center"
      >
        <div className="text-3xl font-bold tracking-widest text-white drop-shadow-lg">
          通用进销存系统
        </div>
        <div className="mt-2 text-sm tracking-wide text-sky-200/80">大鱼上钩 · 开张大吉</div>
      </motion.div>

      <div className="absolute inset-x-0 bottom-6 text-center text-xs text-sky-200/50">
        点击任意处跳过
      </div>
    </motion.div>
  )
}
