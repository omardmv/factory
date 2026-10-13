// factory shot: open <appBase><path> signed in (curl's cookie jar) and save a
// screenshot. Called by bin/factory, which supplies FACTORY_JAR and, for
// previews, FACTORY_BASIC ("user:password").
//   node shot.mjs <appBase> <path> [--width N] [--height N] [--full] [--out file] [--wait ms]
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [appBase, path = '/', ...rest] = process.argv.slice(2);
const opt = { width: 1280, height: 800, full: false, out: '', wait: 0 };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--full') opt.full = true;
  else if (a === '--width') opt.width = Number(rest[++i]);
  else if (a === '--height') opt.height = Number(rest[++i]);
  else if (a === '--out') opt.out = rest[++i];
  else if (a === '--wait') opt.wait = Number(rest[++i]);
  else { console.error(`unknown option ${a}`); process.exit(2); }
}
if (opt.width < 500 && opt.height === 800) opt.height = 844; // phone

// curl's Netscape jar -> Playwright cookies
const cookies = readFileSync(process.env.FACTORY_JAR, 'utf8').split('\n').flatMap((line) => {
  const httpOnly = line.startsWith('#HttpOnly_');
  if (!line.trim() || (line.startsWith('#') && !httpOnly)) return [];
  const [domain, , cpath, secure, expires, name, value] = line.replace('#HttpOnly_', '').split('\t');
  return [{ name, value, domain: domain.replace(/^\./, ''), path: cpath, secure: secure === 'TRUE',
            httpOnly, expires: Number(expires) || -1, sameSite: 'Lax' }];
});

const basic = process.env.FACTORY_BASIC;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: opt.width, height: opt.height },
    deviceScaleFactor: opt.width < 500 ? 3 : 1,
    ...(basic ? { httpCredentials: { username: basic.split(':')[0], password: basic.slice(basic.indexOf(':') + 1) } } : {}),
  });
  await context.addCookies(cookies);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = appBase.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`);
  const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  if (opt.wait) await page.waitForTimeout(opt.wait);
  const host = new URL(url).hostname.split('.')[0];
  const out = opt.out || `/tmp/factory-shot-${host}-${path.replace(/[^a-z0-9]+/gi, '_')}-${opt.width}.png`;
  await page.screenshot({ path: out, fullPage: opt.full });
  console.log(JSON.stringify({ screenshot: out, url: page.url(), status: res?.status(), title: await page.title(), console_errors: errors }, null, 2));
} finally {
  await browser.close();
}
