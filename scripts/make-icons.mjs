// Draws the ECLIRIM mark and renders the extension's icons from it. The mark is original to this project:
// a dark body with light escaping around its rim, the way the extension lights the rim of the screen.
//   node scripts/make-icons.mjs        (writes public/icons/*; run it again only when the mark changes)
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const defs = `
    <linearGradient id="rim" x1="20" y1="16" x2="110" y2="114" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff0d6"/><stop offset=".3" stop-color="#ffb868"/><stop offset=".66" stop-color="#ea6c9c"/><stop offset="1" stop-color="#7c7dff"/>
    </linearGradient>
    <radialGradient id="spark" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#fff1d8" stop-opacity=".9"/><stop offset="1" stop-color="#ffc98a" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6.5"/></filter>`;
// `rim`: how wide the lit rim is drawn. Small icons get a wider one, or it would vanish between pixels.
const mark = (rim, glow = true) => `
  ${glow ? `<rect x="27" y="27" width="74" height="74" rx="23" fill="none" stroke="url(#rim)" stroke-width="${rim * 1.6}" filter="url(#soft)" opacity=".8"/>` : ''}
  <rect x="27" y="27" width="74" height="74" rx="23" fill="none" stroke="url(#rim)" stroke-width="${rim}"/>
  <rect x="27" y="27" width="74" height="74" rx="23" fill="#07080b"/>
  ${glow ? '<circle cx="33.5" cy="33.5" r="12" fill="url(#spark)"/>' : '<circle cx="33" cy="33" r="10" fill="#fff4e0"/>'}`;
const svg = (body, tile) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>${defs}
    <radialGradient id="tile" cx="50%" cy="40%" r="80%"><stop offset="0" stop-color="#1c1e28"/><stop offset="1" stop-color="#090a0e"/></radialGradient>
  </defs>${tile ? '\n  <rect width="128" height="128" rx="29" fill="url(#tile)"/>' : ''}${body}
</svg>
`;
await mkdir('public/icons', { recursive: true });
// The mark alone, for the pages' own headers, and the full icon on its tile.
await writeFile('public/icons/mark.svg', svg(mark(9), false));
await writeFile('public/icons/icon.svg', svg(mark(9), true));
const browser = await chromium.launch({ channel: 'chromium' });
try {
  // Every size on a fresh page, shot as the element itself once it has the size asked for.
  const render = async (size, body, path) => {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>${svg(body, true)}`);
    await page.waitForFunction(size => document.querySelector('svg').getBoundingClientRect().height === size, size);
    await page.locator('svg').screenshot({ path, omitBackground: true });
    await page.close();
  };
  for (const size of [16, 32, 48, 128])
    await render(size, size <= 16 ? mark(20, false) : size <= 32 ? mark(15, false) : size <= 48 ? mark(11) : mark(9), `public/icons/icon-${size}.png`);
  // A large render for documents.
  await render(512, mark(9), 'docs/eclirim-icon.png');
} finally { await browser.close(); }
console.log('ECLIRIM icons → public/icons/');
