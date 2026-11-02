import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { Store } from './store';
import { createApp } from './app';

const store = new Store(resolve(process.env.DATA_DIR || 'data'));
await store.init();
const { app, close } = createApp({ store, apiKey: process.env.OPENROUTER_API_KEY });
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
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { close(); server.close(() => process.exit(0)); });
