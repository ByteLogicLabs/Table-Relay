import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@/components': path.resolve(__dirname, './src/components'),
        '@/lib': path.resolve(__dirname, './src/lib'),
        '@': path.resolve(__dirname, '.'),
      },
    },
    clearScreen: false,
    build: {
      // No production sourcemaps: a packaged desktop app never ships them, and
      // generating them is a major memory consumer during `vite build` (the
      // build was OOMing on CI's default ~2 GB Node heap). Keeping them off plus
      // the raised heap in the `build` script keeps CI builds reliable.
      sourcemap: false,
      // Monaco alone pushes the main bundle past 5 MB, so the default 500 kB
      // warning is just noise here. Split further with manualChunks if startup
      // size becomes a concern.
      chunkSizeWarningLimit: 6000,
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: 'ws',
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ['**/src-tauri/**'],
      },
    },
  };
});
