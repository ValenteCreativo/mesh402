import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { demoBridge } from './dev-bridge.js';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [demoBridge()],
  server: { host: '127.0.0.1', port: 4020, strictPort: true },
  preview: { host: '127.0.0.1', port: 4020, strictPort: true },
  build: { outDir: '../dist-visual', emptyOutDir: true },
});
