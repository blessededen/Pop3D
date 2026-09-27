import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { handleApi } from './server/api.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      react(),
      {
        name: 'pop3d-api',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/api/')) return next();
            handleApi(req, res, env).catch(next);
          });
        },
      },
    ],
    server: { host: '127.0.0.1', port: 5174, strictPort: true },
    test: { include: ['src/**/*.test.ts'] },
  };
});
