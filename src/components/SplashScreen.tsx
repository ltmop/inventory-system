// 启动画面（通用版）：蓝色渐变底 + 店铺图标 + 品牌名，数据加载完成后播放
// 纯 SVG + motion，无图片资源；只用 opacity/scale，全程约 2.5 秒
import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Store } from 'lucide-react'

const EXIT_AT_MS = 2050

export function SplashScreen({ onFinish }: { onFinish: () => void }) {
  const [exiting, setExiting] = useState(false)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (reduceMotion) {
      onFinish()
      return
    }
    const t = setTimeout(() => {
      setExiting(true)
      setTimeout(onFinish, 400)
    }, EXIT_AT_MS)
    return () => clearTimeout(t)
  }, [reduceMotion, onFinish])

  return (
    <motion.div
      className="fixed inset-0 z-[999] flex flex-col items-center justify-center bg-gradient-to-br from-blue-600 via-blue-700 to-cyan-800"
      animate={exiting ? { opacity: 0, scale: 1.04 } : { opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: 'easeInOut' }}
      onClick={() => {
        setExiting(true)
        setTimeout(onFinish, 300)
      }}
    >
      {/* 品牌图标 */}
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="flex size-20 items-center justify-center rounded-2xl bg-white shadow-2xl"
      >
        <Store className="size-10 text-blue-600" />
      </motion.div>

      {/* 品牌名 */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.45, duration: 0.45 }}
        className="mt-5 text-center"
      >
        <div className="text-2xl font-bold tracking-wide text-white">通用进销存</div>
        <div className="mt-1.5 text-[13px] text-blue-100">AI 智能管理系统</div>
      </motion.div>

      {/* 底部加载提示 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.9 }}
        className="absolute bottom-12 text-xs text-blue-200"
      >
        正在加载本地数据…
      </motion.div>
    </motion.div>
  )
}
