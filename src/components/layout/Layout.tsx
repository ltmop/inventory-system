import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { motion } from 'motion/react'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { CommandPalette } from '@/components/CommandPalette'
import { CloudLoginGate } from '@/components/CloudLoginGate'
import { LowStockAlert } from '@/components/LowStockAlert'
import { useAppStore } from '@/store/appStore'
import { backend, setGuestMode } from '@/lib/api'

export function Layout() {
  const [collapsed, setCollapsed] = useState(false)
  const location = useLocation()
  const error = useAppStore((s) => s.error)
  const cloudPaired = useAppStore((s) => s.cloud.paired)
  const cloudAuth = useAppStore((s) => s.cloudAuth)
  const setCloudAuth = useAppStore((s) => s.setCloudAuth)

  // 挂载时拉一次云配对状态（CloudCard 未挂载时也要能判断已登录）
  useEffect(() => {
    if (!backend) return
    backend.invoke('cloud:status').then((s) => {
      if (s) useAppStore.setState({ cloud: { ...useAppStore.getState().cloud, ...s } })
    }).catch(() => {})
  }, [])

  // 已配对云账号的用户重启：自动视为已登录（覆盖本地模式/local），不再弹登录门
  useEffect(() => {
    if (cloudPaired && cloudAuth !== 'logged') setCloudAuth('logged')
  }, [cloudPaired, cloudAuth, setCloudAuth])

  return (
    <div className="flex h-screen overflow-hidden bg-gradient-to-br from-[#f2f6f9] via-[#eef3f8] to-[#e6eef5] dark:from-[#0a1628] dark:via-[#0c1a2e] dark:to-[#0a1628]">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：现代后台骨架 */}
        <TopBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        <main className="min-h-0 flex-1 overflow-auto p-6">
        {/* 游客只读模式横幅：跳过登录后可见 */}
        <GuestBanner />
        {/* 数据层错误条：加载失败等全局问题在这里亮出来，而不是闷死 */}
        {error && (
          <div className="mb-4 flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-sm">
            <span>{error}</span>
            <button
              className="shrink-0 font-medium text-red-500 hover:text-red-700"
              onClick={() => useAppStore.setState({ error: null })}
            >
              关闭
            </button>
          </div>
        )}
        {/* 路由切换时整页淡入上移，key 变化触发重挂载 */}
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <Outlet />
        </motion.div>
        </main>
      </div>
      {/* 低库存开机提醒：每次启动弹一次 */}
      <LowStockAlert />
      {/* Ctrl+K 全局命令面板 */}
      <CommandPalette />
      {/* 云账号登录门：未登录/未跳过时全屏弹出 */}
      <CloudLoginGate />
    </div>
  )
}

/** 本地模式提示横幅：从登录门跳过（guest）后显示在内容区顶部，提醒数据在本机、可登录同步 */
function GuestBanner() {
  const cloudAuth = useAppStore((s) => s.cloudAuth)
  if (cloudAuth !== 'guest') return null
  return (
    <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-800">
      <span>
        <span className="font-bold">本地模式：</span>所有操作照常可用，数据保存在这台电脑；登录账号后多台电脑自动同步
      </span>
      <button
        className="shrink-0 font-medium text-sky-700 hover:text-sky-900 cursor-pointer"
        onClick={() => {
          setGuestMode(false)
          useAppStore.setState({ cloudAuth: 'none' })
        }}
      >
        去登录
      </button>
    </div>
  )
}
