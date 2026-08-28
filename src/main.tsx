import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/plus-jakarta-sans/400.css'
import '@fontsource/plus-jakarta-sans/500.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/plus-jakarta-sans/700.css'
import './index.css'
import App from './App.tsx'

// 渲染进程崩溃上报：DSN 从编译时常量取，未配置/初始化失败静默降级
try {
  if (import.meta.env.VITE_SENTRY_DSN) {
    import('@sentry/electron/renderer').then((Sentry) => {
      Sentry.init({ dsn: import.meta.env.VITE_SENTRY_DSN })
    })
  }
} catch { /* 挂了是免费版，不是打不开 */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
