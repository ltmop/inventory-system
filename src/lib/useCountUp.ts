import { useEffect, useState } from 'react'
import { animate } from 'motion/react'

/** 数字滚动：从 0 弹到目标值，用于卡片统计数字展示 */
export function useCountUp(target: number, duration = 0.9): number {
  const [val, setVal] = useState(0)
  useEffect(() => {
    const controls = animate(0, target, {
      duration,
      ease: 'easeOut',
      onUpdate: (v) => setVal(v),
    })
    return () => controls.stop()
  }, [target, duration])
  return val
}
