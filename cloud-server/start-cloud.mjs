import { spawn } from 'node:child_process'
const child = spawn('node', ['index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ADMIN_KEY: 'test-admin-key-123',
    PORT: '3199',
    CLOUD_DATA_ROOT: 'C:\\Users\\Administrator\\Desktop\\库存管理\\cloud-data',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (d) => process.stdout.write(d))
child.stderr.on('data', (d) => process.stderr.write(d))
console.log('CLOUD_SERVER_PID=' + child.pid)
process.on('SIGTERM', () => child.kill())
