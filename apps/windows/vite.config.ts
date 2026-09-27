import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Tauri serves the built assets from `dist` (see tauri.conf.json `frontendDist`).
export default defineConfig({
  plugins: [react()],
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
