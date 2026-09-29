---
title: "GTA IV Companion App"
slug: "gta-iv-companion-app"
category: "Apps & Games"
status: "In Progress"
summary: "A learning-first companion app project built around GTA IV, with an emphasis on thoughtful product design and modern web-development skills."
heroMedia:
  src: "/projects/placeholders/gta.svg"
  alt: "Abstract city-map interface illustration representing the GTA IV Companion App"
timeline:
  - label: "Companion app learning project established"
    date: "2026-07-16"
  - label: "Development workflow and UI-first preferences defined"
    date: "2026-07-21"
  - label: "Timeline data model and ordering work"
    date: "2026-07-21"
  - label: "Ongoing product and architecture iteration"
    date: "2026-09-29"
---
## The idea

The GTA IV Companion App is deliberately a learning project first and an app second. The goal is to learn professional web-development habits by building something interesting enough that I actually care whether it works well.

That means learning HTML, CSS, JavaScript, Git, GitHub, project architecture, PWAs, deployment, and product thinking as parts of one real application instead of a parade of disconnected tutorials.

Liberty City already has enough chaos; the companion app does not need to contribute any.

## What it does

The app is being designed as a polished companion experience for GTA IV, organizing useful game information into an interface that feels intentional rather than like a spreadsheet wearing a leather jacket.

One early architecture lesson came from timeline data: sorting records and then grouping them by type lost the original interleaving in the rendered experience. Fixing that meant preserving both grouped views and an ordered item stream—exactly the kind of problem that is much easier to understand when it affects a product you are actually using.

## Why it matters

This project is a sandbox for learning how software is really built: not just writing code, but deciding how data should flow, how interfaces should behave, how changes are versioned, and why architecture decisions matter later.

AI can help explain and accelerate the work, but the project is intentionally not “ask AI to make an app and come back when it is done.” The learning is the feature.

The app is allowed to be ambitious. Its data model is not allowed to drive like a Liberty City cab.

## What I learned

The biggest lesson so far is that implementation details become much easier to understand when they solve a visible product problem. Git branches, rendering models, data structures, and deployment stop being abstract vocabulary.

I also learned that the UI can reveal architecture mistakes very quickly. If the timeline is in the wrong order, users do not care that the underlying objects were technically sorted at some earlier point. Rude, but fair.
