import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';

/** 手元の開発サーバーで API に中継するパス（src/lib/api.ts と合わせる） */
const DEV_API_PREFIX = '/api';

/**
 * 手元の開発サーバーから、デプロイ済みの API へ中継する。
 * 本番の API の CORS は本番のサイトのオリジンしか許さないので、ブラウザからは同じオリジン
 * （http://localhost:5173/api/...）を呼ばせ、開発サーバーがサーバー側から API へ送る。
 * 接続先は public/config.json（infra/scripts/write-web-config.ts で作る）の apiUrl。
 */
function devApiProxy(): Record<string, ProxyOptions> {
  const file = fileURLToPath(new URL('./public/config.json', import.meta.url));
  if (!existsSync(file)) return {};
  const { apiUrl } = JSON.parse(readFileSync(file, 'utf8')) as { apiUrl?: string };
  if (!apiUrl) return {};
  return {
    [DEV_API_PREFIX]: {
      target: apiUrl,
      changeOrigin: true,
      rewrite: (p) => p.slice(DEV_API_PREFIX.length),
      // API から見て、ブラウザからの別オリジンの呼び出しに見せない
      configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: command === 'serve' ? devApiProxy() : undefined,
  },
  build: { chunkSizeWarningLimit: 800 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
