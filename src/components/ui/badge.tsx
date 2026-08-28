import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 gap-1 [&>svg]:size-3 [&>svg]:pointer-events-none transition-colors overflow-hidden',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-white',
        outline: 'text-foreground',
        success: 'border-transparent bg-green-100 text-green-800',
        warning: 'border-transparent bg-amber-100 text-amber-800',
        // 状态徽章：红=预警/绿=正常/金=待处理
        'seal-green': 'seal-green',
        'seal-sand': 'seal-sand',
        'seal-red': 'seal-red',
        'seal-purple': 'inline-flex items-center gap-1 rounded border-2 border-purple-500 px-2 py-0.5 text-xs font-bold text-purple-600 bg-purple-50/70',
        'seal-gray': 'inline-flex items-center gap-1 rounded border-2 border-slate-400 px-2 py-0.5 text-xs font-bold text-slate-500 bg-slate-100/70',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
