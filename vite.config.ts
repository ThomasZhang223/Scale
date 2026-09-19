import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // reachable from the Quest over LAN/adb reverse
    port: 5173,
  },
});
