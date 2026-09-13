import type { Plugin } from 'vite';
import { createBridge } from '../server/bridge.js';
export function demoBridge(): Plugin {
  async function install(server: any) {
    const bridge = await createBridge({ origin: process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:4020' });
    server.middlewares.use(async (req: any, res: any, next: () => void) => {
      if (req.url === '/operator') req.url = '/operator.html';
      if (!await bridge(req, res)) next();
    });
  }
  return { name: 'mesh402-local-demo', configureServer: install, configurePreviewServer: install };
}
