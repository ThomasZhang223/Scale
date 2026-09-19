import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    fs: { allow: ['../..'] }, // fixtures/ lives at the repo root, outside this app
  },
});
