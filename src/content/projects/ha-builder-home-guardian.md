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
  - label: "Home Caretaker observation foundation"
    date: "2026-09-23"
  - label: "HA Builder architecture and safety baseline"
    date: "2026-09-28"
  - label: "Metadata-only editing accepted"
    date: "2026-09-28"
  - label: "Backup and exact-change verification added"
    date: "2026-09-29"
  - label: "Bounded behavior changes begin"
    date: "2026-09-29"
learnings:
  - "Observation and mutation are different trust problems and deserve different agents."
  - "Small accepted capability batches make smart-home automation easier to reason about and safer to expand."
  - "Backups and exact-change verification should be built into the workflow before behavior-changing edits."
---
## The idea

HA Builder and Home Guardian split one tempting “AI for the smart home” idea into two jobs with very different trust requirements.

**HA Builder** is the maker. It focuses on supported Home Assistant configuration changes. **Home Guardian** is the watcher: it observes useful home-system signals and surfaces things that deserve attention. Keeping those roles separate is intentional.

## What it does

Home Guardian starts from read-only awareness—looking for meaningful conditions without quietly deciding that every unusual sensor reading needs an intervention.

HA Builder follows a gated build workflow. Its capabilities expand in small batches, with backups, validation, exact-change tracking, and owner approval where a change affects live behavior. Early work intentionally started with safer metadata changes before moving toward bounded script behavior.

## Why it matters

A smart home is unusually personal infrastructure. A bad automation is not just a failed test; it can turn off the wrong thing, wake someone up, or create the exciting new household ritual of asking why the lights are doing that.

Separating observation from mutation makes the system easier to trust and easier to expand. Each agent has a clear job and a clear boundary.

## What I learned

The safest path to a capable agent is incremental. Proving read-only observation, then constrained edits, then backup and verification behavior creates a much stronger foundation than starting with broad device control.

I also learned that “can the agent change this?” is only half the question. “Can it prove exactly what changed, recover safely, and know when to ask?” is usually the more important half.
