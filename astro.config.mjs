import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  // Phase 2: add @astrojs/cloudflare adapter when server-side API routes are needed
});
