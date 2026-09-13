import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// This gate is deliberately scoped to the operator-funded demo, never /api/*.
export function operatorGate(secret: string | undefined, origin: string) {
  const sessions = new Map<string, number>();
  let attempts = 0, windowStart = Date.now();
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const authorized = (req: IncomingMessage) => {
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('mesh402_operator='))?.slice(17);
    return !!token && (sessions.get(token) ?? 0) > Date.now();
  };
  return { authorized, sameOrigin: (req: IncomingMessage) => req.headers.origin === origin,
    login(value: string, res: ServerResponse) {
      if (Date.now() - windowStart > 60_000) { attempts = 0; windowStart = Date.now(); }
      if (++attempts > 10 || !secret || !timingSafeEqual(digest(value), digest(secret))) return false;
      for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);
      const token = randomBytes(32).toString('hex'); sessions.set(token, Date.now() + 3600_000);
      res.setHeader('Set-Cookie', `mesh402_operator=${token}; HttpOnly; SameSite=Strict; Path=/demo; Max-Age=3600${origin.startsWith('https:') ? '; Secure' : ''}`);
      return true;
    },
  };
}
