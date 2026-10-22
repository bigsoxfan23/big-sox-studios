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

Requirements: Node.js 24.22.0 (see `.nvmrc`) and npm 10.9.4.

```bash
npm ci --include=dev --include=optional
npm run dev
```

Validation: `npm run check`, `npm run lint`, `npm run build`, or `npm run validate`. Production output is `dist/`.

## Deployment

Task 11b deployment requires the separate owner approval gates in [the production deployment plan](docs/TASK11B_PRODUCTION_DEPLOYMENT_PLAN.md). The original setup notes below are historical; do not enable preview builds or deploy the membership changes from these notes alone.

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
