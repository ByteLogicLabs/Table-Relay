import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {readFileSync} from 'fs';
import {defineConfig, loadEnv} from 'vite';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// App version, sourced from package.json so it's the single place to bump for
// the in-app version display + update check. Read at build time and injected as
// `process.env.APP_VERSION`.
const pkgVersion = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
})();

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      // Repo URL for the "version" link in Settings. Falls back to the known
      // repo when GIT_URL isn't set (e.g. CI without a local .env).
      'process.env.GIT_URL': JSON.stringify(
        env.GIT_URL || 'https://github.com/ByteLogicLabs/Table-Relay',
      ),
      // Version from package.json (the file the team bumps). Drives the in-app
      // version label + update check, instead of Tauri's tauri.conf.json.
      'process.env.APP_VERSION': JSON.stringify(pkgVersion),
      // Dev-only debug overlay. Off by default even in dev; set DEV_DEBUG=true
      // in .env to show the floating bug panel.
      'process.env.DEV_DEBUG': JSON.stringify(env.DEV_DEBUG || 'false'),
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
