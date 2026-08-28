// 404 兜底页：访问不存在的路由时给出明确指引
import { Link } from 'react-router-dom'
import { Compass, House } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6">
      <Compass className="size-14 text-slate-300" />
      <h1 className="mt-4 text-xl font-bold text-slate-800">页面不存在</h1>
      <p className="mt-2 text-sm text-slate-500">你要找的页面可能已被移动或删除</p>
      <Button asChild className="mt-6">
        <Link to="/">
          <House className="size-4" />
          返回首页
        </Link>
      </Button>
    </div>
  )
}
