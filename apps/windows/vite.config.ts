import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '../../packages/shared/src/constants';

// Tauri serves the built assets from `dist` (see tauri.conf.json `frontendDist`).

/**
 * The port the backup server listens on, compiled into the dashboard.
 *
 * The Rust side reads `LOCALDROP_PORT` and falls back to `DEFAULT_PORT`
 * (`http::server::server_port`). The dashboard has no IPC channel to ask the server where it
 * lives, so the same value is injected here at build time - `tauri dev` and `tauri build` both
 * run this and the Rust binary in one shell, so they see one environment.
 */
const serverPort = Number(process.env.LOCALDROP_PORT ?? DEFAULT_PORT);

export default defineConfig({
  plugins: [react()],
  define: {
    __LOCALDROP_SERVER_PORT__: JSON.stringify(serverPort),
  },
  resolve: {
    alias: {
      // Compile the shared contract from source rather than its `dist` output, so editing a
      // protocol type is picked up immediately without a separate build step.
      '@localdrop/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  // A fixed port with `strictPort` so `tauri dev` never silently picks a different one and
  // leaves the window pointing at nothing.
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    outDir: 'dist',
    target: 'chrome105',
    sourcemap: true,
    emptyOutDir: true,
  },
});
