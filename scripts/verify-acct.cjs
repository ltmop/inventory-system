
const { _electron } = require('playwright');
(async () => {
  const app = await _electron.launch({
    executablePath: 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\inventory-system\\通用进销存系统.exe',
    args: [],
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await new Promise(r => setTimeout(r, 7000));
  await win.evaluate(() => {
    const ok = [...document.querySelectorAll('button')].find(b => b.textContent.includes('知道了'));
    if (ok) ok.click();
  });
  await win.evaluate(() => { location.hash = '#/account' });
  await new Promise(r => setTimeout(r, 2500));
  // 点「立即同步」（当前已登录 测试店791358）
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('立即同步'));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 6000));
  const afterSync = await win.evaluate(() => {
    const text = document.querySelector('main')?.textContent || '';
    return {
      synced: text.includes('上次同步'),
      tail: text.slice(-120),
    };
  });
  console.log('AFTER_SYNC=' + JSON.stringify(afterSync));
  await app.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
