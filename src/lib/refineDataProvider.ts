// refine dataProvider：把现有后端桥（window.fi.invoke，IPC/HTTP 通用）适配成 refine 的 CRUD 接口
// PoC 阶段：只实现 products 列表，验证"refine 接现有 Node 后端"这条前端开源化路线。
import type { DataProvider } from '@refinedev/core'
import { backend } from './api'

const invoke = (channel: string, payload?: unknown): Promise<any> => {
  if (!backend) throw new Error('后端不可用（纯浏览器 dev 模式没接后端）')
  return backend.invoke(channel, payload)
}

export const refineDataProvider: DataProvider = {
  getList: async ({ resource }) => {
    const res = String(resource)
    if (res === 'products' || res === 'batches') {
      const all = await invoke('data:loadAll')
      const data = (all?.[res] ?? []) as any[]
      // PoC：前端全量分页/排序/过滤，后端不动
      return { data, total: data.length }
    }
    throw new Error(`PoC dataProvider 暂不支持 resource: ${res}`)
  },

  getOne: async () => {
    throw new Error('PoC 未实现 getOne')
  },
  getMany: async () => {
    throw new Error('PoC 未实现 getMany')
  },
  create: async () => {
    throw new Error('PoC 未实现 create（业务操作走自定义表单）')
  },
  update: async () => {
    throw new Error('PoC 未实现 update')
  },
  deleteOne: async () => {
    throw new Error('PoC 未实现 deleteOne')
  },
  getApiUrl: () => '',
  custom: async () => {
    throw new Error('PoC 未实现 custom')
  },
}
