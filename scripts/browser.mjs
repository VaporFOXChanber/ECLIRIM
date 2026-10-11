// How the test browsers are started, in one place.
//
// A test browser that plays sound registers with macOS as the "Now Playing" app. Play/pause from the keyboard, from
// headphones or from the system then goes to the test page instead of to whatever the person at this Mac is listening
// to, and a pause sent by Bluetooth earphones stops the test's player a few seconds in (seen on 2026-10-10 with
// earphones connected: the player paused 3–4 s after every start, with or without the extension). So the test browsers
// are started with Chrome's media key handling off.
//
// Chrome reads only the last --disable-features switch, and Playwright already passes one. Its list is read from a
// first, empty launch and passed again together with ours, in a single switch.
import { chromium } from 'playwright';
const OURS = ['HardwareMediaKeyHandling'];
let known;
async function defaults() {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage(); await page.goto('chrome://version');
    const line = await page.evaluate(() => document.querySelector('#command_line')?.textContent || document.body.innerText);
    return line.split(/\s+(?=--)/).find(arg => arg.startsWith('--disable-features=')) || '';
  } finally { await browser.close(); }
}
/** Launch options with the media key handling off. `options.args` may not carry a --disable-features of its own. */
export async function quiet(options = {}) {
  known ??= defaults();
  const theirs = await known, list = [...new Set([...theirs.replace('--disable-features=', '').split(',').filter(Boolean), ...OURS])];
  if ((options.args || []).some(arg => arg.startsWith('--disable-features='))) throw new Error('Pass features to disable through scripts/browser.mjs');
  return { ...options, ignoreDefaultArgs: [...(Array.isArray(options.ignoreDefaultArgs) ? options.ignoreDefaultArgs : []), ...(theirs ? [theirs] : [])], args: [...(options.args || []), `--disable-features=${list.join(',')}`] };
}
