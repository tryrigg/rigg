// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://tryrigg.com',
  output: 'static',
  integrations: [
    starlight({
      title: 'Rigg docs',
      description:
        'Documentation for building, validating, and running local-first agent workflows with Rigg.',
      tagline: 'Documentation for local-first agent workflows',
      favicon: '/favicon.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/tryrigg/rigg',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/tryrigg/rigg/edit/main/www/',
      },
      customCss: ['./src/styles/starlight.css'],
      sidebar: [
        { slug: 'docs' },
        {
          label: 'Workflows',
          autogenerate: { directory: 'docs/workflows' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'docs/reference' },
        },
        {
          label: 'Examples',
          autogenerate: { directory: 'docs/examples' },
        },
      ],
      lastUpdated: true,
      credits: false,
    }),
    sitemap(),
  ],
  vite: {
    optimizeDeps: { exclude: ['@resvg/resvg-js'] },
  },
});
