import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // 상대경로로 빌드해야 GitHub Pages 의 /저장소이름/ 하위에서도 그대로 돌아간다.
  base: './',

  server: {
    host: true,        // 같은 공유기의 다른 기기에서 테스트할 수 있게 LAN 에 노출
    port: 5173,
    // Cloudflare quick tunnel (trycloudflare.com) 로 접속할 수 있게 허용.
    // 터널 URL 이 매번 랜덤이라 전체 허용. dev 서버 전용 설정이다.
    allowedHosts: true,
    proxy: {
      // 개발 중엔 화면은 Vite, 게임 로직은 3000번 서버가 맡는다.
      // 프록시를 걸어두면 클라이언트 코드는 배포 때와 똑같이 같은 오리진의
      // /ws 만 보면 된다.
      // [debug] 클라이언트 에러 수집용 — 임시 진단 코드
      '/__debug': {
        target: 'http://localhost:3000',
        configure(proxy) {
          proxy.on('error', () => {});
        },
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        // 게임 서버를 고치면 node --watch 가 재시작하는데, 그때 프록시가
        // ECONNRESET 을 받고 처리되지 않으면 Vite 프로세스까지 죽는다.
        // 여기서 삼켜야 화면 쪽이 살아남아 브라우저가 알아서 재접속한다.
        configure(proxy) {
          proxy.on('error', (err) => {
            console.warn(`[ws proxy] ${err.code ?? err.message} — 게임 서버 재시작 중일 수 있습니다`);
          });
        },
      },
    },
  },

  build: {
    target: 'esnext',
    assetsInlineLimit: 0,   // GLB·텍스처를 base64 로 인라인하지 않는다

    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        inspect: resolve(import.meta.dirname, 'inspect.html'),
        convert: resolve(import.meta.dirname, 'convert.html'),
      },
      output: {
        // three 는 거의 안 바뀌는데 게임 코드는 자주 바뀐다.
        // 갈라놔야 코드 고칠 때마다 745KB 를 다시 받지 않는다.
        // (Vite 8 = Rolldown 이라 객체가 아닌 함수로 줘야 한다)
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },

  assetsInclude: ['**/*.glb', '**/*.gltf', '**/*.ktx2', '**/*.hdr', '**/*.exr'],
});
