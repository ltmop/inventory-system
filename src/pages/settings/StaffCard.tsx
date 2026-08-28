// 员工账号（v0.1）：多用户登录 + 老板/店员角色。
// 默认关闭（单机老板照旧直接用）；开启后启动要选人登录，操作日志记到每个人头上。
import { useEffect, useState } from 'react'
import { Pencil, Plus, ShieldCheck, Trash2, Users } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useAppStore } from '@/store/appStore'
import { USER_ROLE_LABELS, type User, type UserRole } from '@/types'

const EMPTY_FORM = { name: '', username: '', password: '', role: 'staff' as UserRole }

/** 员工账号管理卡：开关 + 员工列表 + 新建/改/删（自包含，不走 SettingsPage props） */
export function StaffCard() {
  const currentUser = useAppStore((s) => s.currentUser)
  const staffLoginOn = useAppStore((s) => s.staffLoginOn)
  const setStaffLogin = useAppStore((s) => s.setStaffLogin)
  const listUsers = useAppStore((s) => s.listUsers)
  const createUser = useAppStore((s) => s.createUser)
  const updateUser = useAppStore((s) => s.updateUser)
  const deleteUser = useAppStore((s) => s.deleteUser)
  const staffLogout = useAppStore((s) => s.staffLogout)

  const [users, setUsers] = useState<User[]>([])
  const [form, setForm] = useState(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  // 编辑态：点"改"展开该行的内联编辑
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState({ name: '', password: '', role: 'staff' as UserRole, active: 1 })

  const reload = () => {
    void listUsers().then(setUsers).catch(() => {})
  }
  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flash = (msg: string) => {
    setOk(msg)
    setTimeout(() => setOk(''), 3000)
  }

  const toggleLogin = async (on: boolean) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (on) {
        // 开启前检查：至少有 1 个老板账号才让开，否则登录门一开没人进得去
        const list = await listUsers()
        const hasOwner = list.some((u) => u.role === 'owner' && u.active)
        if (!hasOwner) {
          setError('先建一个「老板」账号（角色选老板）再开启登录，不然开完谁都进不来')
          return
        }
      }
      await setStaffLogin(on)
      flash(on ? '员工登录已开启：下次启动要选人登录' : '员工登录已关闭：恢复直接进软件')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitCreate = async () => {
    if (busy) return
    if (!form.name.trim() || !form.username.trim() || !form.password) {
      setError('名字、登录名、密码都要填')
      return
    }
    setBusy(true)
    setError('')
    try {
      await createUser({ ...form, name: form.name.trim(), username: form.username.trim() })
      setForm(EMPTY_FORM)
      flash(`已建员工「${form.name.trim()}」`)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitEdit = async (u: User) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const payload: { name: string; role: UserRole; active: number; password?: string } = {
        name: editForm.name.trim() || u.name,
        role: editForm.role,
        active: editForm.active,
      }
      if (editForm.password) payload.password = editForm.password
      await updateUser(u.id, payload)
      setEditingId(null)
      flash(`已保存「${payload.name}」`)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitDelete = async (u: User) => {
    if (busy) return
    if (!window.confirm(`确定删掉员工「${u.name}（${u.username}）」吗？删掉后他/她就登录不了了。`)) return
    setBusy(true)
    setError('')
    try {
      await deleteUser(u.id)
      flash(`已删除员工「${u.name}」`)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const isOwner = currentUser?.role === 'owner'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-5 text-brand-500" />
          员工账号
          {currentUser && (
            <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-normal text-brand-700">
              当前：{currentUser.name}（{USER_ROLE_LABELS[currentUser.role]}）
            </span>
          )}
        </CardTitle>
        <CardDescription>
          默认关闭，一个人用跟以前一样。开启后启动要选人登录，谁记的账、谁删的货，操作日志里都有名字。
          店员不能删商品/供应商/客户，老板账号至少保留一个。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 开关 + 退出登录 */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant={staffLoginOn ? 'outline' : 'default'}
            onClick={() => toggleLogin(!staffLoginOn)}
            disabled={busy}
            className={staffLoginOn ? '' : 'bg-brand-600 hover:bg-brand-700'}
          >
            {staffLoginOn ? '关闭员工登录' : '开启员工登录'}
          </Button>
          {staffLoginOn && currentUser && (
            <Button
              variant="ghost"
              onClick={() => void staffLogout().then(() => flash('已退出，回到登录界面'))}
            >
              退出登录（换人）
            </Button>
          )}
          <span className="text-xs text-slate-400">
            {staffLoginOn ? '已开启：启动必须登录' : '已关闭：打开软件直接用'}
          </span>
        </div>
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {ok && <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{ok}</div>}

        {/* 员工列表 */}
        {users.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">
            还没有员工账号。开启登录前，先建一个「老板」账号
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名字</TableHead>
                <TableHead>登录名</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  {editingId === u.id ? (
                    <>
                      <TableCell>
                        <Input
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          placeholder={u.name}
                          className="h-7 w-28 text-xs"
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{u.username}</TableCell>
                      <TableCell>
                        <Select
                          value={editForm.role}
                          onValueChange={(v) => setEditForm({ ...editForm, role: v as UserRole })}
                        >
                          <SelectTrigger className="h-7 w-20 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="owner">老板</SelectItem>
                            <SelectItem value="manager">高管</SelectItem>
                            <SelectItem value="staff">店员</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={String(editForm.active)}
                          onValueChange={(v) => setEditForm({ ...editForm, active: Number(v) })}
                        >
                          <SelectTrigger className="h-7 w-16 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">在用</SelectItem>
                            <SelectItem value="0">停用</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="password"
                            value={editForm.password}
                            onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                            placeholder="新密码（不填不改）"
                            className="h-7 w-32 text-xs"
                          />
                          <Button size="sm" onClick={() => submitEdit(u)} disabled={busy}>
                            保存
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            取消
                          </Button>
                        </div>
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="font-medium">{u.name}</TableCell>
                      <TableCell className="font-mono text-xs">{u.username}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1">
                          {u.role === 'owner' && <ShieldCheck className="size-3.5 text-brand-500" />}
                          {USER_ROLE_LABELS[u.role]}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            u.active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {u.active ? '在用' : '停用'}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {isOwner && (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setEditingId(u.id)
                                setEditForm({ name: u.name, password: '', role: u.role, active: u.active })
                              }}
                            >
                              <Pencil className="size-3" />
                              改
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-600 hover:text-red-700"
                              onClick={() => submitDelete(u)}
                              disabled={busy}
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                        )}
                        {!isOwner && <span className="text-xs text-slate-400">只有老板能改</span>}
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* 新建员工 */}
        {isOwner && (
          <div className="rounded-xl border border-brand-100 bg-brand-50/50 px-4 py-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700">
              <Plus className="size-4 text-brand-500" />
              新建员工
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="名字（如：小李）"
                className="w-32"
              />
              <Input
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                placeholder="登录名（至少2个字）"
                className="w-40"
              />
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="密码（至少4位）"
                className="w-32"
              />
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as UserRole })}>
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="staff">店员</SelectItem>
                  <SelectItem value="manager">高管</SelectItem>
                  <SelectItem value="owner">老板</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={submitCreate} disabled={busy} className="bg-brand-600 hover:bg-brand-700">
                {busy ? '保存中...' : '建账号'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
