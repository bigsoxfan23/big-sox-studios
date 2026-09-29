# Big Sox Studios

Public website for **Big Sox Studios** — *A small studio for big ideas.*

Projects, experiments, and useful ideas across AI, travel, tech, and everyday life.

## Architecture

- Astro 7.x + TypeScript
- Static generation by default
- GitHub `main` is production source of truth
- Cloudflare Workers with Static Assets
- Cloudflare Workers Builds / Git integration for deployment
- No database, CMS, visitor accounts, or public login in v1
- Public site has no inbound connection to private infrastructure

## Local development

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run dev
```

Validation: `npm run check`, `npm run lint`, `npm run build`, or `npm run validate`. Production output is `dist/`.

## Deployment

The repository is prepared for an asset-only Cloudflare Worker using `wrangler.toml`.

Cloudflare Workers Builds settings:
- Production branch: `main`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Enable preview builds for pull requests/branches

Replace the placeholder `site` value in `astro.config.mjs` with the final custom domain before production launch.

## Content

Content collections are defined in `src/content.config.ts` for Projects, Austin Favorites, Newsletter archive, and Public Agents.

Agent content is intentionally public-safe only. Never add credentials, private endpoints, IP addresses, Tailscale details, internal logs/incidents, approval/action systems, private topology, or administrative controls.

## Batch policy

Implementation is performed in bounded batches. Batch 1 establishes the stable foundation only; finished page designs begin with Batch 2.
