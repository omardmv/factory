// node render.mjs <html> <png> : screenshot a local HTML page at its SVG size
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
const [src, out] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1900, height: 1060 }, deviceScaleFactor: 2 });
await p.goto(pathToFileURL(src).href, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: out, clip: { x: 0, y: 0, width: 1900, height: 1060 } });
await b.close();
