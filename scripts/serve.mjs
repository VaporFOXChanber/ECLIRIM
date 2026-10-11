import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function serve(port = 4173) {
  const root = resolve('test-page');
  const handler = async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      const info = await stat(file); const body = await readFile(file);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webm': 'video/webm', '.mp4': 'video/mp4' }[extname(file)] || 'application/octet-stream';
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2] || info.size - 1), info.size - 1);
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' }); res.end(body.subarray(start, end + 1));
      } else { res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' }); res.end(body); }
    } catch { res.writeHead(404).end('Not found'); }
  };
  const servers = await Promise.all([port, port + 1].map(p => new Promise(resolveServer => {
    const server = http.createServer(handler); server.listen(p, '127.0.0.1', () => resolveServer(server));
  })));
  return { close: () => Promise.all(servers.map(s => new Promise(r => s.close(r)))) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await serve(Number(process.env.PORT || 4173)); console.log('ECLIRIM Light Lab: http://localhost:4173');
}
