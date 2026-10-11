import { readFile, mkdir, writeFile } from 'node:fs/promises';
/** One source of truth for bundled manual translations and Chrome's native locale catalogs. */
export async function buildLocales() {
  const messages = JSON.parse(await readFile('src/shared/messages.json', 'utf8'));
  const ids = new Set(), sources = new Set();
  const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(m => m[0]).sort().join(',');
  for (const m of messages) {
    if (ids.has(m.id) || sources.has(m.ja)) throw new Error(`Duplicate translation: ${m.id}`);
    if (!m.ja || !m.en || placeholders(m.ja) !== placeholders(m.en)) throw new Error(`Missing translation or placeholder mismatch: ${m.id}`);
    ids.add(m.id); sources.add(m.ja);
  }
  for (const locale of ['ja', 'en']) {
    const output = Object.fromEntries(messages.map(m => [m.id, { message: m[locale] }]));
    const named = (source) => ({ message: messages.find(m => m.ja === source)[locale] });
    output.extensionDescription = named('映像の色と光を、画面の外周へ。端末内で動くシネマティック照明。');
    output.compareCommand = named('A/B 比較：表示する側（A・B）を切り替える');
    await mkdir(`dist/_locales/${locale}`, { recursive: true });
    await writeFile(`dist/_locales/${locale}/messages.json`, JSON.stringify(output, null, 2) + '\n');
  }
  console.log(`i18n: ${messages.length} messages × 2 locales`);
}
