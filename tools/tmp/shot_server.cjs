// 임시 — 브라우저 페이지가 만든 파일을 받아 저장한다 (localhost:5199)
//   ?out=shots (기본) → tools/tmp/shots   캐릭터 사진 (char_shot.html)
//   ?out=sfx          → public/sfx        효과음 (sfx_build.html)
const http = require('http'), fs = require('fs'), path = require('path');
const DIRS = { shots: path.join(__dirname, 'shots'), sfx: path.join(__dirname, '../../public/sfx') };
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') { res.end('ok'); return; }
  const q = new URL(req.url, 'http://x').searchParams;
  const name = q.get('name').replace(/[^\w.-]/g, '');
  const dir = DIRS[q.get('out')] ?? DIRS.shots;
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
    console.log('saved', dir, name, Buffer.concat(chunks).length);
    res.end('saved');
  });
}).listen(5199, '127.0.0.1');
