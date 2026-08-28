import { CheckCircle2, DatabaseBackup, FolderOpen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatRelativeTime } from '@/lib/formatters'
import type { BackupStatus } from '@/types'

interface BackupCardProps {
  /** Electron 主进程桥（浏览器 mock 模式为 null，备份按钮置灰） */
  hasBackend: boolean
  backupDir: string | undefined
  bStatus: BackupStatus | null
  /** 超期未备份天数（stale=true 时顶端红条用） */
  staleDays: number
  backing: boolean
  restoring: boolean
  extraBusy: boolean
  backupResult: string
  error: string
  onBackup: () => void
  onRestore: () => void
  onSetExtraDir: () => void
  onClearExtraDir: () => void
}

/** 数据备份卡片：自动备份说明 + 状态总览 + 立即备份/恢复 + 第二备份位置 */
export function BackupCard({
  hasBackend,
  backupDir,
  bStatus,
  staleDays,
  backing,
  restoring,
  extraBusy,
  backupResult,
  error,
  onBackup,
  onRestore,
  onSetExtraDir,
  onClearExtraDir,
}: BackupCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <DatabaseBackup className="size-5 text-brand-500" />
          数据备份
        </CardTitle>
        <CardDescription>
          系统每天凌晨 3:00 自动备份，并在软件正常退出前再备份一次，只保留最近 7 份。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 超过 3 天没备份：卡片顶部红条提醒 */}
        {bStatus?.stale && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            已经 {staleDays} 天没备份了，点下面「立即备份」备份一次——数据丢了可找不回来
          </div>
        )}

        {/* 备份状态总览：上次时间 / 共几份 / 备份位置 */}
        {hasBackend && bStatus && (
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="rounded-lg bg-slate-50 px-4 py-3">
              <div className="text-xs text-slate-500">上次备份</div>
              <div className={`mt-0.5 font-medium ${bStatus.lastBackupAt ? 'text-slate-800' : 'text-amber-600'}`}>
                {bStatus.lastBackupAt ? formatRelativeTime(bStatus.lastBackupAt) : '还没有备份过'}
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 px-4 py-3">
              <div className="text-xs text-slate-500">备份份数</div>
              <div className="mt-0.5 font-medium text-slate-800">共 {bStatus.backupCount} 份</div>
            </div>
            <div className="rounded-lg bg-slate-50 px-4 py-3">
              <div className="text-xs text-slate-500">备份位置</div>
              <div className="mt-0.5 font-mono text-xs break-all text-slate-800">
                {backupDir ?? '读取中…'}
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-4">
          <Button
            onClick={onBackup}
            disabled={!hasBackend || backing}
            className="bg-brand-600 hover:bg-brand-700"
          >
            <DatabaseBackup className="size-4" />
            {backing ? '备份中...' : '立即备份'}
          </Button>
          <Button
            variant="outline"
            onClick={onRestore}
            disabled={!hasBackend || restoring || backing}
          >
            {restoring ? '恢复中...' : '从备份恢复'}
          </Button>
          {!hasBackend && (
            <span className="text-sm text-muted-foreground">
              浏览器开发模式使用 mock 数据，备份功能请在 Electron 应用中使用
            </span>
          )}
        </div>

        {/* 第二备份位置：硬盘坏了本机备份也会丢，强烈建议设一个 U 盘/网盘文件夹 */}
        {hasBackend && bStatus && (
          bStatus.extraDir ? (
            <div className="space-y-2 rounded-lg border border-slate-200 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span
                  className={`inline-block size-2.5 shrink-0 rounded-full ${
                    bStatus.extraDirOk ? 'bg-green-500' : 'bg-red-500'
                  }`}
                />
                <span className="font-medium text-slate-800">第二备份位置</span>
                <span className="font-mono text-xs break-all text-slate-600">{bStatus.extraDir}</span>
              </div>
              <div className={`text-xs ${bStatus.extraDirOk ? 'text-green-700' : 'text-red-600'}`}>
                {bStatus.extraDirOk
                  ? '状态正常：每次备份后会自动再复制一份过去'
                  : `最近复制失败：${bStatus.extraError ?? '文件夹写不进去，U 盘是不是拔了？插上后会自动恢复'}`}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={onSetExtraDir} disabled={extraBusy}>
                  换个位置
                </Button>
                <Button variant="ghost" size="sm" onClick={onClearExtraDir} disabled={extraBusy}>
                  取消第二位置
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <span className="flex-1 text-sm text-amber-700">
                第二备份位置未设置——硬盘坏了备份也会一起丢，建议选个 U 盘或网盘文件夹
              </span>
              <Button variant="outline" size="sm" onClick={onSetExtraDir} disabled={extraBusy}>
                <FolderOpen className="size-4" />
                {extraBusy ? '选择中...' : '选择 U 盘/网盘文件夹'}
              </Button>
            </div>
          )
        )}

        {backupResult && (
          <div className="flex items-start gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>
              备份成功：<span className="font-mono text-xs">{backupResult}</span>
            </span>
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
      </CardContent>
    </Card>
  )
}
