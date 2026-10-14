// itch.io 업로드용 zip — 화면 파일만 (게임 서버는 따로 돌고, 접속 주소를 빌드에 박는다)
//
//   node tools/pack_itch.mjs [wss://서버/ws]   →   ~/Downloads/feral-itch.zip
//
// 유튜브에서 받은 라운드 시작 곡(sfx/s_spawn_*)은 저작권 때문에 뺀다 — 없으면 게임은 그 소리만 건너뛴다.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER = process.argv[2] ?? 'wss://feralfps.duckdns.org:8443/ws';
const OUT = 'dist-itch';
const ZIP = path.join(os.homedir(), 'Downloads', 'feral-itch.zip');

execSync(`npx vite build --outDir ${OUT} --emptyOutDir`, { stdio: 'inherit', env: { ...process.env, VITE_SERVER_URL: SERVER } });
for (const f of fs.readdirSync(path.join(OUT, 'sfx'))) if (f.startsWith('s_spawn_')) fs.rmSync(path.join(OUT, 'sfx', f));
for (const f of ['convert.html', 'inspect.html']) fs.rmSync(path.join(OUT, f), { force: true });   // 개발용 도구 페이지
fs.rmSync(ZIP, { force: true });
// 윈도우 내장 bsdtar 로 묶는다 — 경로 구분을 / 로 쓴다 (PowerShell Compress-Archive 는 \ 라 itch 에서 폴더가 깨진다).
// zip 맨 위에 index.html 이 바로 있어야 해서 맨 위 항목들을 이름으로 넘긴다.
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
execFileSync(TAR, ['-a', '-c', '-f', ZIP, '-C', OUT, ...fs.readdirSync(OUT)], { stdio: 'inherit' });
console.log(`✅ ${ZIP} — ${(fs.statSync(ZIP).size / 1048576).toFixed(1)} MB · 서버 ${SERVER}`);
