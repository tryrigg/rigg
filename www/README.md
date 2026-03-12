# Rigg website

The `www` app is a static Astro site deployed with Cloudflare Workers Static Assets.

## Commands

Run all commands from `/Users/aktky/dev/github.com/tryrigg/rigg/www`.

| Command | Action |
| :------ | :----- |
| `bun install` | Install dependencies |
| `bun dev` | Start Astro's local dev server |
| `bun check` | Run Astro checks |
| `bun build` | Build the production site into `dist/` |
| `bun preview` | Build the site and preview it with `wrangler dev` |
| `bun deploy` | Manually deploy the Worker with `wrangler deploy` |

## Deployment

- `wrangler.jsonc` is the source of truth for the Cloudflare Worker configuration.
- Production deployments are expected to run through Cloudflare Workers Builds with:
  - Root directory: `www`
  - Build command: `bun run build`
  - Build watch paths: `www/*`, `install`
  - Build variable: `BUN_VERSION=1.3.10`
- Attach `tryrigg.com` as a custom domain to the `rigg-www` Worker after the first successful production build.
