import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { Store } from './store';
import { createApp } from './app';

const store = new Store(resolve(process.env.DATA_DIR || 'data'));
await store.init();
const maxUploadMB = Number(process.env.MAX_UPLOAD_MB || 10240);
if (!Number.isFinite(maxUploadMB) || maxUploadMB < 1) throw new Error('MAX_UPLOAD_MB must be a positive number.');
const { app, close } = createApp({ store, apiKey: process.env.OPENROUTER_API_KEY, wanApiKey: process.env.WAN_API_KEY, maxUploadBytes: Math.floor(maxUploadMB * 1024 * 1024) });
if (process.env.NODE_ENV === 'production') {
  const directory = resolve('dist/client');
  app.use(express.static(directory));
  app.get('/{*path}', (_req, res) => { res.sendFile(resolve(directory, 'index.html')); });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => console.log(`\n  Frame Video Studio\n  Local: http://${host}:${port}\n`));
// Large originals stream directly to disk and can take longer than Node's default request timeout.
server.requestTimeout = 0;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await close(); server.close(() => process.exit(0)); });
