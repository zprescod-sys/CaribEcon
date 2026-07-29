import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://caribecon.org',
  output: 'static',
  integrations: [sitemap()],
  // Phase 2: add @astrojs/cloudflare adapter when server-side API routes are needed
});
