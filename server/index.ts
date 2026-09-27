// 배포용 서버: dist 정적 파일 + /api. 추가 의존성 없이 Node 22.18+ 에서 실행된다(npm start).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { handleApi } from './api.ts';

// Explicit process environment wins; local settings override shared defaults.
for (const file of ['.env.local', '.env']) {
  try { process.loadEnvFile(file); } catch { /* Optional environment file. */ }
}

const DIST = resolve('dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, process.env);

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  let file = join(DIST, rel);
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    res.statusCode = 403;
    return res.end();
  }
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(DIST, 'index.html');
  }
  try {
    const body = await readFile(file);
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    if (file.startsWith(join(DIST, 'assets') + sep)) {
      res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    }
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('dist 폴더가 없습니다. 먼저 npm run build 를 실행하세요.');
  }
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`Pop-3D: http://localhost:${port}`);
});
