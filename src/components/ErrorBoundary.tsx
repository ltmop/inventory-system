// 全局错误边界：任意页面渲染崩溃时兜底，绝不白屏
import { Component, type ReactNode } from 'react'
import { CircleAlert, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  message: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  componentDidCatch(error: unknown, info: unknown) {
    // 保留控制台堆栈，便于远程排障；界面只给用户看友好提示
    console.error('[ErrorBoundary] 页面崩溃：', error, info)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#e8eef6] px-6">
        <CircleAlert className="size-14 text-red-500" />
        <h1 className="mt-4 text-xl font-bold text-slate-800">页面出错了，请刷新重试</h1>
        <p className="mt-2 max-w-md text-center text-sm text-slate-500">
          你的数据都存在本地数据库里，不受影响。如果刷新后还出现这个页面，请把下面的错误信息发给维护人员。
        </p>
        {this.state.message && (
          <pre className="mt-4 max-w-lg overflow-auto rounded-lg bg-slate-100 px-4 py-2 text-xs text-slate-500">
            {this.state.message}
          </pre>
        )}
        <Button className="mt-6" onClick={() => window.location.reload()}>
          <RotateCw className="size-4" />
          刷新页面
        </Button>
      </div>
    )
  }
}
