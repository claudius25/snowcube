import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'textures');
mkdirSync(outDir, { recursive: true });

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.end();

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const name = (req.url ?? '/').replace(/^\//, '');
    if (!/^[a-z0-9-]+\.png$/.test(name)) {
      res.statusCode = 400;
      return res.end('bad name');
    }
    const file = join(outDir, name);
    writeFileSync(file, Buffer.from(body, 'base64'));
    console.log('wrote', file);
    res.end('ok');
  });
});

server.listen(8899, () => console.log('listening on 8899'));
