// 本地优先守卫：不登录也能全功能使用（数据在本机）；canOperate 恒为 true，
// guestBlock() 仅用于"未登录时提示去登录同步"（不拦截任何操作）。
import { useAppStore } from '@/store/appStore'

export function useGuestGuard() {
  const cloudAuth = useAppStore((s) => s.cloudAuth)
  // 本地模式可全功能操作；登录与否只影响云同步
  const canOperate = true
  const guestBlock = () => {
    // 弹提示并打开登录门（仅引导，不强制）
    if (cloudAuth !== 'logged') useAppStore.setState({ cloudAuth: 'none' })
  }
  return { canOperate, guestBlock }
}
