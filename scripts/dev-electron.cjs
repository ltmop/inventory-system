// 开发模式一键启动：先起 Vite，就绪后拉起 Electron 加载 dev server
const { spawn } = require('child_process')
const http = require('http')

const DEV_URL = 'http://localhost:5173'

function waitForVite(retries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      http
        .get(DEV_URL, (res) => {
          res.resume()
          resolve()
        })
        .on('error', () => {
          if (left <= 0) return reject(new Error('Vite dev server 启动超时'))
          setTimeout(() => attempt(left - 1), 500)
        })
    }
    attempt(retries)
  })
}

;(async () => {
  const vite = spawn('npm.cmd', ['run', 'dev'], { stdio: 'inherit', shell: false })
  const cleanup = () => {
    try { vite.kill() } catch {}
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  await waitForVite()
  const electron = spawn(
    'node_modules/.bin/electron.cmd',
    ['.'],
    { stdio: 'inherit', shell: false, env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL } },
  )
  electron.on('close', cleanup)
})().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
