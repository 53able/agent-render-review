import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `npm run dev` forwards the API and render files to a Director started with `RENDER_DIRECTOR_DEV=1 node server.mts`
// (PORT as for the Director, default 4747). Director accepts only Host/Origin 127.0.0.1:<port>, so the proxy rewrites
// Host always and Origin only when it is this dev server's own origin: other origins still reach Director unchanged
// and are refused there.
const DIRECTOR = `127.0.0.1:${Number(process.env.PORT || 4747)}`;
const toDirector: ProxyOptions = {
  target: `http://${DIRECTOR}`,
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq, req) => {
      proxyReq.setHeader('host', DIRECTOR);
      if (req.headers.origin && req.headers.origin === `http://${req.headers.host}`) proxyReq.setHeader('origin', `http://${DIRECTOR}`);
    });
  },
};

// The UI source lives in web/; the Director serves the built output from dist/.
// scripts/build.mts overrides outDir to dist.tmp and swaps it into place.
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': toDirector, '/runs': toDirector },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
