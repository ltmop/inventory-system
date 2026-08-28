// 游客只读模式守卫：跳过登录后只能看，不能写。
// 用法：const { canOperate, guestBlock } = useGuestGuard() —— canOperate=false 时禁用写按钮，guestBlock() 提示去登录。
import { useAppStore } from '@/store/appStore'

export function useGuestGuard() {
  const cloudAuth = useAppStore((s) => s.cloudAuth)
  const canOperate = cloudAuth === 'logged'
  const guestBlock = () => {
    // 弹提示并打开登录门
    useAppStore.setState({ cloudAuth: 'none' })
  }
  return { canOperate, guestBlock }
}
