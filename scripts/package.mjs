import { mkdir, mkdtemp, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a numeric extension version.');
const channel = process.argv[2] || '';
if (channel && !/^beta\.\d+$/.test(channel)) throw new Error('Release channel must be beta.N, or omitted.');
// Distribution is explicit. Maps, local notes, symlinks and unknown files are rejected.
const allowedFiles = new Set([
  'LICENSE', 'manifest.json', 'popup.html', 'options.html', 'offscreen.html',
  'popup.css', 'options.css',
  ...['background', 'content', 'offscreen', 'popup', 'options'].map(name => `${name}.js`),
  ...[16, 32, 48, 128].map(size => `icons/icon-${size}.png`),
  'icons/icon.svg', 'icons/mark.svg',
  ...['ja', 'en'].map(locale => `_locales/${locale}/messages.json`),
]);
const foundFiles = new Set();
async function verifyDistribution(directory, prefix = '') {
  for await (const entry of await opendir(directory)) {
    const name = prefix + entry.name;
    if (entry.isDirectory() && [...allowedFiles].some(file => file.startsWith(`${name}/`))) {
      await verifyDistribution(resolve(directory, entry.name), `${name}/`);
    } else if (entry.isFile() && allowedFiles.has(name)) {
      foundFiles.add(name);
    } else {
      throw new Error('Unexpected distribution entry; remove unapproved files before packaging.');
    }
  }
}
await verifyDistribution(resolve('dist'));
for (const file of allowedFiles) {
  if (!foundFiles.has(file)) throw new Error(`Missing distribution file: ${file}. Run npm run build first.`);
}
const [license, builtLicense] = await Promise.all([readFile('LICENSE'), readFile('dist/LICENSE')]);
if (!license.equals(builtLicense)) throw new Error('The packaged license differs from LICENSE. Run npm run build first.');

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Ordinary ZIP with sorted files, fixed 1980-01-01 DOS date, fixed 0644 permissions,
// and no extra fields, comments, directory entries, filesystem paths or owner IDs.
const localParts = [], centralParts = [];
let offset = 0;
for (const file of [...allowedFiles].sort()) {
  const name = Buffer.from(file, 'utf8');
  const raw = await readFile(join('dist', file));
  const compressed = deflateRawSync(raw, { level: 9 });
  const checksum = crc32(raw);
  if (raw.length >= 0xffffffff || compressed.length >= 0xffffffff || offset >= 0xffffffff) {
    throw new Error('Distribution exceeds the supported ordinary ZIP size.');
  }
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt16LE(0x0021, 12);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
  localParts.push(local, name, compressed);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0x0021, 14); central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0x81a40000, 38);
  central.writeUInt32LE(offset, 42); centralParts.push(central, name);
  offset += local.length + name.length + compressed.length;
}
const directory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(allowedFiles.size, 8); end.writeUInt16LE(allowedFiles.size, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const archiveBytes = Buffer.concat([...localParts, directory, end]);
const hash = createHash('sha256').update(archiveBytes).digest('hex');
const filename = `ECLIRIM-${version}${channel ? `-${channel}` : ''}.zip`;
await mkdir('releases', { recursive: true });
const temporary = await mkdtemp(resolve('releases/.package-'));
try {
  await writeFile(join(temporary, filename), archiveBytes);
  await writeFile(join(temporary, filename + '.sha256'), `${hash}  ${filename}\n`);
  await rename(join(temporary, filename), resolve('releases', filename));
  await rename(join(temporary, filename + '.sha256'), resolve('releases', filename + '.sha256'));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(`releases/${filename}`);
console.log('SHA256', hash);
