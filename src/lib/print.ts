// 打印辅助：给 body 挂打印模式 class，@media print 下只显示 .print-area（见 index.css）。
// Electron 的 window.print() 会拉起系统打印对话框，可选「另存为 PDF」，不用动主进程。

export type PrintMode = 'receipt' | 'labels'

export function printArea(mode: PrintMode): void {
  const cls = `print-${mode}`
  document.body.classList.add(cls)
  const cleanup = () => {
    document.body.classList.remove(cls)
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  window.print()
  // 兜底：个别环境 afterprint 不触发，1 分钟后强制摘掉（class 只影响打印媒体，挂着也无害）
  window.setTimeout(cleanup, 60_000)
}
