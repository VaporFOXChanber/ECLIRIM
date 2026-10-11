// Real extension + real Chrome UI locales in disposable profiles. Never uses the everyday Chrome profile.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { quiet } from './browser.mjs';
import { serve } from './serve.mjs';
import { openPopup } from './cdp-popup.mjs';

const baselineZip = process.env.ECLIRIM_UPGRADE_BASELINE_ZIP;
if (!baselineZip) throw new Error('Supply ECLIRIM_UPGRADE_BASELINE_ZIP with a locally retained baseline ZIP; historical binaries are not included in this public source snapshot.');
const out = 'artifacts/global', results = [], errors = [], root = await mkdtemp(join(tmpdir(), 'eclirim-global-'));
await mkdir(out, { recursive: true });
const server = await serve(4193), origin = 'http://localhost:4193';
const pause = ms => new Promise(r => setTimeout(r, ms));
const until = async (read, label) => { const end = Date.now() + 15000; while (Date.now() < end) { const value = await read().catch(() => false); if (value) return value; await pause(80); } throw Error(label); };
const record = (name, detail = {}) => { results.push({ name, result: 'PASS', detail }); console.log('PASS', name, JSON.stringify(detail)); };
const fields = ['settings', 'profiles', 'presets'];
const japanese = /[ぁ-んァ-ヶ一-龯。、]/;
const tabs = ['lighting','glow','director','pulse','studio','wizard','presets','profiles','diagnostics','feedback'];
let context;
async function launch(locale, folder = resolve('dist'), profile = '') {
  let executablePath;
  // --lang alone does not override macOS's UI language. NSArgumentDomain overrides only this test process.
  if (process.platform === 'darwin') {
    executablePath = join(root, `chrome-${locale}`);
    await writeFile(executablePath, `#!/bin/sh\nexec '${chromium.executablePath().replaceAll("'", "'\\''")}' "$@" -AppleLanguages '(${locale})'\n`, { mode: 0o700 });
  }
  const c = await chromium.launchPersistentContext(profile, await quiet({ ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: process.platform !== 'darwin', viewport: { width: 1280, height: 900 },
    args: [`--lang=${locale}`, '--mute-audio', '--enable-unsafe-extension-debugging', `--disable-extensions-except=${folder}`, `--load-extension=${folder}`] }));
  // Only local fixtures are allowed onto the network; feedback is not sent by this test.
  await c.route(/^https?:\/\//, route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const manager = await c.newPage(); await manager.goto('chrome://extensions');
  if (!await manager.locator('#devMode').evaluate(el => el.checked)) await manager.locator('#devMode').click();
  await manager.close();
  c.on('page', p => p.on('pageerror', e => errors.push(String(e))));
  return c;
}
const ready = page => page.waitForFunction(() => !document.documentElement.hasAttribute('data-i18n-pending') && document.querySelector('#version')?.textContent === 'v0.9.9' && !document.querySelector('#feedback-fields')?.disabled);
async function scan(page) {
  return page.evaluate(() => {
    const text = document.body.innerText + '\n' + [...document.querySelectorAll('[title],[aria-label],[placeholder],option,optgroup')].map(e => [e.getAttribute('title'),e.getAttribute('aria-label'),e.getAttribute('placeholder'),e.tagName === 'OPTION' ? e.textContent : '',e.getAttribute('label')].join(' ')).join('\n');
    const overflow = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && getComputedStyle(e).visibility !== 'hidden' && r.right > innerWidth + 1; }).slice(0,8).map(e => ({ tag:e.tagName,id:e.id, right:e.getBoundingClientRect().right }));
    return { text, width:innerWidth, scroll:document.documentElement.scrollWidth, overflow };
  });
}
try {
  for (const locale of ['ja','en','fr']) {
    context = await launch(locale);
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = sw.url().split('/')[2];
    const native = await sw.evaluate(() => ({ ui: chrome.i18n.getUILanguage(), description: chrome.runtime.getManifest().description, message: chrome.i18n.getMessage('extensionDescription'), version: chrome.runtime.getManifest().version }));
    assert.ok(native.ui.startsWith(locale), JSON.stringify(native)); assert.equal(native.version,'0.9.9');
    assert.equal(japanese.test(native.description), locale === 'ja'); assert.equal(native.description,native.message);
    const video = await context.newPage(); await video.goto(origin); await video.locator('#play').waitFor();
    const cdp = await context.browser().newBrowserCDPSession(); let popup = await openPopup(cdp,id,video.url());
    await until(() => popup.evaluate('document.querySelector("#start") && !document.documentElement.hasAttribute("data-i18n-pending")'), 'popup initialized');
    await popup.evaluate('document.querySelector("#start").click()');
    await until(() => popup.evaluate('document.querySelector("#state").textContent === "Active"'), 'video active');
    if (locale !== 'ja') assert.ok(!japanese.test(await popup.evaluate('document.body.innerText')), 'English popup has no Japanese');
    await popup.evaluate('document.body.style.width="320px";document.documentElement.style.width="320px"');
    await pause(250);
    await popup.evaluate('document.querySelectorAll("details").forEach(e=>e.open=true)');
    assert.equal(await popup.evaluate('document.body.getBoundingClientRect().width === 320 && document.body.scrollWidth <= 320'),true,'320px popup fits');
    await writeFile(`${out}/popup-${locale}-320.png`,Buffer.from((await popup.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true})).data,'base64'));
    await popup.close();
    const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`); await ready(options);
    assert.equal(await options.locator('html').getAttribute('lang'),locale==='ja'?'ja':'en');
    assert.equal(await options.locator('#language').inputValue(),'auto');
    for (const width of locale==='fr' ? [320] : [320,390,768,1280]) {
      await options.setViewportSize({width,height:1000});
      for (const section of tabs) {
        await options.evaluate(section=>document.querySelector(`[data-tab="${section}"]`).click(),section);
        await options.evaluate(()=>document.querySelectorAll('details').forEach(e=>e.open=true));
        await pause(180);
        const seen=await scan(options); assert.ok(seen.scroll<=width && !seen.overflow.length,JSON.stringify({locale,section,...seen,text:undefined}));
        if(locale!=='ja') assert.ok(!japanese.test(seen.text),`${section}: ${seen.text.split('\n').filter(s=>japanese.test(s)).join('\n')}`);
        if(width===320 && locale!=='fr' || width===1280 && locale==='en') await options.screenshot({path:`${out}/${locale}-${section}-${width}.png`,fullPage:true});
      }
    }
    // Wizard result, preset operations, error messages, A/B labels, and diagnostic attachment preview.
    await options.evaluate(()=>document.querySelector('[data-tab="wizard"]').click());
    for(let i=0;i<3;i++) await options.locator('#wizard-next').click();
    if(locale!=='ja') assert.ok(!japanese.test((await scan(options)).text),'wizard result');
    await options.evaluate(()=>document.querySelector('[data-tab="presets"]').click());
    await options.locator('#import-text').fill('{broken'); await options.locator('#import-paste').click();
    if(locale!=='ja') assert.match(await options.locator('#import-message').innerText(),/JSON/);
    // Import an old CineGlow preset without changing stable names or applying it.
    await options.locator('#import-text').fill(JSON.stringify({app:'CineGlow',kind:'preset',schema:3,name:'Legacy look',look:{brightness:29}}));
    await options.locator('#import-paste').click();
    await until(()=>sw.evaluate(async()=> (await chrome.storage.local.get('presets')).presets?.['Legacy look']?.brightness===29),'old preset imported');
    await options.evaluate(()=>document.querySelector('[data-tab="feedback"]').click());
    await options.locator('#feedback-problem').fill('Test draft: preserve my input $& {0}.');
    await options.locator('#feedback-diagnostics-load').click(); await until(()=>options.locator('#feedback-diagnostics-load').isEnabled(),'diagnostics loaded');
    assert.equal(await options.locator('#feedback-diagnostics-confirm').isChecked(),false);
    await options.locator('#feedback-diagnostics-confirm').check();
    if(locale!=='ja') { assert.ok(!japanese.test(await options.locator('#feedback-preview').inputValue()));assert.ok(!japanese.test(await options.locator('#feedback-diagnostics-preview').inputValue())); }
    const payload=await sw.evaluate(()=>chrome.storage.local.get(['settings','profiles','presets','feedbackDraft']));
    assert.ok(!JSON.stringify(payload).includes('Test draft: preserve my input') || payload.feedbackDraft.problem.includes('$& {0}'));
    const before=await sw.evaluate(keys=>chrome.storage.local.get(keys),fields);
    await options.evaluate(()=>document.querySelector('[data-tab="lighting"]').click());
    await options.locator('#compare-start').click(); await until(()=>sw.evaluate(async()=>!!(await chrome.storage.local.get('compare')).compare),'compare started');
    // Keep the live video visible in its own window while options stay open, and retain the renderer identity.
    const tabId=await sw.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id,video.url());
    await sw.evaluate(tabId=>chrome.windows.create({tabId,focused:false}),tabId);
    await video.evaluate(()=>window.__originalLight=document.querySelector('#eclirim-lighting'));
    await sw.evaluate(async()=>{const {settings}=await chrome.storage.local.get('settings');await chrome.storage.local.set({settings:{...settings,hud:true}})});
    const withHud=await sw.evaluate(keys=>chrome.storage.local.get(keys),fields);
    Object.assign(before,withHud);
    await until(()=>video.evaluate(()=>!!document.querySelector('#eclirim-hud')),'HUD visible');
    const initialHud=await video.evaluate(()=>document.querySelector('#eclirim-hud').shadowRoot.textContent);
    assert.equal(japanese.test(initialHud),locale==='ja');
    const next=locale==='ja'?'en':'ja';
    await options.locator('#language').selectOption(next); await options.waitForFunction(next=>document.documentElement.lang===next && !document.documentElement.hasAttribute('data-i18n-pending'),next); await ready(options);
    assert.deepEqual(await sw.evaluate(keys=>chrome.storage.local.get(keys),fields),before);
    await until(()=>video.evaluate(()=>document.querySelector('#eclirim-hud')?.shadowRoot.textContent).then(text=>japanese.test(text||'')===(next==='ja')),'HUD follows language');
    assert.equal(await sw.evaluate(async()=> (await chrome.storage.local.get('compare')).compare.active),'b');
    assert.equal(await video.evaluate(()=>window.__originalLight===document.querySelector('#eclirim-lighting')),true,'language retains same renderer');
    await options.locator('[data-side="a"]').click();
    await until(()=>video.evaluate(()=>document.querySelector('#eclirim-compare')?.shadowRoot?.textContent.includes('A')),'comparison badge');
    const badge=await video.evaluate(()=>document.querySelector('#eclirim-compare').shadowRoot.textContent);
    assert.equal(japanese.test(badge),next==='ja');
    await options.locator('#compare-cancel').click();
    await options.evaluate(()=>document.querySelector('[data-tab="feedback"]').click());
    assert.equal(await options.locator('#feedback-problem').inputValue(),'Test draft: preserve my input $& {0}.');
    assert.equal(await options.locator('#feedback-diagnostics-confirm').isChecked(),false,'language refresh resets diagnostic consent');
    // Reload the extension (a service-worker restart) and reopen the UI with the manual preference.
    await sw.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),100)});
    const restarted=await until(async()=>context.serviceWorkers().find(w=>w!==sw&&w.url().includes(id)),'worker restart');
    const again=await context.newPage();await again.goto(`chrome-extension://${id}/options.html`);await ready(again);
    assert.equal(await again.locator('html').getAttribute('lang'),next);assert.equal(await again.locator('#language').inputValue(),next);
    assert.deepEqual(await restarted.evaluate(keys=>chrome.storage.local.get(keys),fields),before);
    // Returning to Auto uses the real native UI language again.
    await again.locator('#language').selectOption('auto');await again.waitForFunction(lang=>document.documentElement.lang===lang&&!document.documentElement.hasAttribute('data-i18n-pending'),locale==='ja'?'ja':'en');
    record(`${locale}: native auto, all tabs, popup 320px, wizard, old preset, feedback, manual switch without lighting reset, restart`,native);
    await context.close();context=null;
  }
  // Real 0.9.8 Beta 2 update in place, then a full browser restart retaining the profile.
  const folder=join(root,'extension'),profile=join(root,'profile');await mkdir(folder);
  execFileSync('unzip',['-q',baselineZip,'-d',folder]);
  context=await launch('ja',folder,profile);
  let sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=sw.url().split('/')[2];
  assert.equal(await sw.evaluate(()=>chrome.runtime.getManifest().version),'0.9.8');
  await until(()=>sw.evaluate(async()=>!!(await chrome.storage.local.get('settings')).settings),'old settings initialized');
  const before=await sw.evaluate(async()=>{
    const {settings}=await chrome.storage.local.get('settings');
    await chrome.storage.local.set({settings:{...settings,brightness:37,mode:'ambient',source:'manual'},profiles:{'www.youtube.com':{brightness:23}},presets:{'日本語の自作':{brightness:19}}});
    return chrome.storage.local.get(['settings','profiles','presets']);
  });
  await cp('dist',folder,{recursive:true});const previous=sw;await sw.evaluate(()=>{setTimeout(()=>chrome.runtime.reload(),100)});
  sw=await until(async()=>context.serviceWorkers().find(w=>w!==previous&&w.url().includes(id)),'0.9.8 update');
  await until(()=>sw.evaluate(()=>chrome.runtime.getManifest().version==='0.9.9'),'updated version');
  assert.equal(sw.url().split('/')[2],id);assert.deepEqual(await sw.evaluate(keys=>chrome.storage.local.get(keys),fields),before);
  let page=await context.newPage();await page.goto(`chrome-extension://${id}/options.html`);await ready(page);assert.equal(await page.locator('html').getAttribute('lang'),'ja');
  await page.locator('#language').selectOption('en');await page.waitForFunction(()=>document.documentElement.lang==='en');
  await context.close();context=await launch('ja',folder,profile);sw=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  page=await context.newPage();await page.goto(`chrome-extension://${id}/options.html`);await ready(page);assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('#language').inputValue(),'en');assert.deepEqual(await sw.evaluate(keys=>chrome.storage.local.get(keys),fields),before);
  const oldManifest=JSON.parse(execFileSync('unzip',['-p',baselineZip,'manifest.json'],{encoding:'utf8'}));const manifest=JSON.parse(await readFile('dist/manifest.json','utf8'));
  for(const key of ['permissions','optional_host_permissions','content_security_policy','minimum_chrome_version'])assert.deepEqual(manifest[key],oldManifest[key]);
  assert.deepEqual(await readFile('LICENSE'),execFileSync('unzip',['-p',baselineZip,'LICENSE']));
  record('0.9.8 Beta 2 → 0.9.9 in place; same ID/data, Japanese initial UI, English persists across full Chrome restart; permissions/CSP/LICENSE unchanged',{id,keys:fields});
  assert.equal(errors.length,0,errors.join('\n'));
} catch(error) {console.error(error);results.push({name:'Failure',result:'FAIL',detail:String(error.stack||error)});process.exitCode=1;
  if(context)for(const [i,page]of context.pages().entries())if(page.url().includes('options.html'))await page.screenshot({path:`${out}/failure-${i}.png`,fullPage:true}).catch(()=>{});
} finally {if(context)await context.close();await server.close();await rm(root,{recursive:true,force:true});await writeFile(`${out}/i18n-results.json`,JSON.stringify({date:new Date().toISOString(),platform:process.platform,results,errors},null,2)+'\n');}
