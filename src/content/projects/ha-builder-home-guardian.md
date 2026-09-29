---
title: "HA Builder & Home Guardian"
slug: "ha-builder-home-guardian"
category: "Smart Home"
status: "In Progress"
summary: "A pair of Home Assistant-focused agents for safer configuration work and proactive home-system awareness."
heroMedia:
  src: "/projects/placeholders/home.svg"
  alt: "Abstract smart-home illustration representing HA Builder and Home Guardian"
timeline:
  - label: "Builder foundation"
    date: "2026-09-28"
  - label: "Bounded editing expansion"
    date: "2026-09-29"
---
## Two agents, two jobs

HA Builder and Home Guardian split smart-home AI work into two intentionally different responsibilities.

**HA Builder** focuses on making carefully bounded changes to supported Home Assistant configuration. **Home Guardian** is the observational side: noticing useful signals and helping surface things that deserve attention.

## Why split them?

Building and watching are different trust problems. Keeping those roles distinct makes it easier to reason about what an agent is allowed to see, what it can change, and when the owner needs to approve something.

## Current direction

The project is actively evolving. Expansion happens in small, tested batches rather than jumping directly to broad home control. The public case study will continue to document the product ideas while keeping private home details and administrative controls out of the site.
