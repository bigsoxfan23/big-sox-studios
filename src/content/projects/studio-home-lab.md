---
title: "Studio Home Lab"
slug: "studio-home-lab"
category: "Infrastructure"
status: "Active"
summary: "A self-hosted environment powering personal media, game servers, monitoring, backups, and experiments in AI-assisted operations."
heroMedia:
  src: "/projects/placeholders/server.svg"
  alt: "Abstract server rack illustration representing the Studio Home Lab"
timeline:
  - label: "Dedicated server platform established"
    date: "2026-08-01"
  - label: "Media, monitoring, and game services consolidated"
    date: "2026-08-20"
  - label: "Off-site backup verification completed"
    date: "2026-09-01"
  - label: "AI operations platform expanded"
    date: "2026-09-23"
  - label: "Production backup coverage re-audited"
    date: "2026-09-29"
  - label: "Infrastructure upgraded"
    date: "2026-10-01"
---
## The idea

What began as a repurposed laptop gradually grew into a much larger infrastructure project. It started with useful personal services and a curiosity about self-hosting, then became a place to learn about containers, media, monitoring, backups, game servers, remote administration, and AI-assisted operations.

It is intentionally practical. Experiments are welcome, but the things that become useful are expected to survive reboots, updates, and the occasional “why is that suddenly offline?” evening.

A good home lab should create experiments, not household folklore about the night everything disappeared.

## What it does

The Studio Home Lab supports personal media, game servers, monitoring, backup workflows, and experiments in AI-assisted infrastructure operations. As the project expanded, these services came to depend on one another, and the original laptop server eventually reached its limits.

The lab's approach is as important as its services: monitor what matters, verify local and off-site backups, document recovery procedures, and keep the studio's private infrastructure separate from the public website. Bounded operators such as Otto can help with diagnostics and carefully controlled operations without turning a public case study into a map of private systems.

This public overview intentionally leaves out addresses, service endpoints, network topology, credentials, and administration interfaces. The lessons are worth sharing; the keys to the infrastructure are not.

## The infrastructure upgrade

In **October 2026**, the studio migrated from the original laptop server to **the studio’s dedicated server**, a business-class desktop intended for ongoing, always-on self-hosted work. The original laptop server was retired after the migration.

The infrastructure upgrade gives the project a more suitable hardware foundation for its current services and future experiments. It is a continuation of the same Studio Home Lab, not a new project with a machine-specific identity.

The original laptop has officially retired. The home lab lives on.

## Why it matters

A home lab turns infrastructure concepts into consequences. Monitoring makes more sense after something fails at an inconvenient time. Backups become more interesting after you imagine rebuilding the machine. Documentation becomes extremely compelling approximately five minutes after forgetting why you configured something six months ago.

The expansion and subsequent upgrade also reinforced an important lesson: a project can outgrow its original hardware without outgrowing its purpose. Useful infrastructure should be designed to evolve.

## What I learned

Reliability is a collection of habits: monitoring, backups, verification, documentation, and resisting unnecessary redesigns. The coolest architecture is not very cool if recovery depends on remembering a command from a terminal window you closed three months ago.

As projects connect to the lab, boundaries and recovery planning become more important, not less. Moving to a dedicated desktop was an infrastructure decision; careful operations remain an ongoing practice.
