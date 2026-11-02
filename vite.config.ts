import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Runtime secrets must not be downloadable through Vite's source-file server.
  server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/credentials.json', '**/credentials.json.tmp', '**/outputs/**'] } },
  build: { outDir: 'dist/client' },
});
