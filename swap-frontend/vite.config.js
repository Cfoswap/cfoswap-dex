import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'bscscan-proxy',
      configureServer(server) {
        server.middlewares.use('/api/verify', async (req, res, next) => {
          if (req.method !== 'POST') return next();
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', async () => {
            try {
              const params = new URLSearchParams(body);
              const apiKey = params.get('apikey');
              const action = params.get('action') || 'verifysourcecode';
              // 移除URL参数，放到query string
              params.delete('apikey');
              params.delete('module');
              params.delete('action');
              const url = `https://api.bscscan.com/v2/api?chainid=56&apikey=${apiKey}&module=contract&action=${action}`;
              console.log('[Proxy] POST to', url);
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 60000);
              const proxyRes = await fetch(url, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                body: params.toString(),
              });
              clearTimeout(timeout);
              const text = await proxyRes.text();
              console.log('[Proxy] Response status:', proxyRes.status, 'body:', text.substring(0, 500));
              res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
              res.end(text);
            } catch (e) {
              console.error('[Proxy] Error:', e);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: '0', result: '代理请求失败: ' + e.message }));
            }
          });
        });
        server.middlewares.use('/api/check-verify', async (req, res, next) => {
          try {
            const queryIndex = req.url.indexOf('?');
            const query = queryIndex >= 0 ? req.url.substring(queryIndex + 1) : '';
            const params = new URLSearchParams(query);
            const apiKey = params.get('apikey');
            const guid = params.get('guid');
            const url = `https://api.bscscan.com/v2/api?chainid=56&apikey=${apiKey}&module=contract&action=checkverifystatus&guid=${guid}`;
            console.log('[Proxy] GET to', url);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            const proxyRes = await fetch(url, {
              signal: controller.signal,
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            });
            clearTimeout(timeout);
            const text = await proxyRes.text();
            console.log('[Proxy] GET response status:', proxyRes.status, 'body:', text.substring(0, 300));
            res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
            res.end(text);
          } catch (e) {
            console.error('[Proxy] GET Error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: '0', result: '代理请求失败: ' + e.message }));
          }
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    host: true,
    fs: {
      allow: ['.'],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2048,
    esbuild: {
      drop: ['console', 'debugger'],
    },
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'react-router': ['react-router-dom'],
          'zustand': ['zustand'],
          'i18n': ['i18next', 'react-i18next'],
          'lucide-react': ['lucide-react'],
        },
      },
    },
  },
});
