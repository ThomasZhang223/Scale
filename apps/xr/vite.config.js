import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ceiling: no HTTPS/mkcert setup here — WebXR on-device requires a secure context,
// wire that up when testing on the Quest over the travel router.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
  },
});
