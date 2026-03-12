// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  vite: {
    optimizeDeps: { exclude: ['@resvg/resvg-js'] },
  },
});
