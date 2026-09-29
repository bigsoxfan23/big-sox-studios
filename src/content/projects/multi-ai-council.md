---
title: "Multi-AI Council"
slug: "multi-ai-council"
category: "AI Systems"
status: "Active"
summary: "A multi-provider deliberation system that brings several AI perspectives together for structured decisions and research."
heroMedia:
  src: "/projects/placeholders/council.svg"
  alt: "Abstract roundtable illustration representing the Multi-AI Council"
timeline:
  - label: "Reusable council foundation"
    date: "2026-09-22"
  - label: "Provider setup and bounded runtime"
    date: "2026-09-24"
  - label: "Fantasy Council integration accepted"
    date: "2026-09-25"
  - label: "Production-runnable council"
    date: "2026-09-26"
---
## The idea

The Multi-AI Council started with a question that sounds obvious until you try to build it: if several strong AI models look at the same decision, can their differences produce a better answer instead of six versions of “it depends”?

The system gives multiple providers the same decision and evidence, lets them analyze independently, then adds critique, dissent, revision, and a final synthesis. The point is not voting. It is to make disagreement useful.

Fantasy football became the first serious proving ground because trades and roster decisions are messy enough to benefit from multiple perspectives but concrete enough to judge afterward. The architecture is reusable for purchases, travel, research, and other decisions.

The Council is deliberately not a democracy of autocomplete boxes; each model has to show its work before the room moves on.

## What it does

A request is prepared with the relevant context and fresh evidence. Four independent analyses examine it, then a critique-and-dissent stage challenges weak assumptions. The models get a chance to revise before a synthesizer produces one coherent recommendation.

Behind that simple flow are deliberately boring but important pieces: provider isolation, normalized evidence, bounded retries, usage tracking, and a reusable runtime. “Ask four robots and hope for wisdom” was not considered an architecture.

## Why it matters

Most multi-model demos stop at putting several answers next to each other. The Council explores the harder question: how do you turn different model strengths into a repeatable decision process?

That makes it useful beyond the original fantasy-football pilot. The interesting product is the deliberation pattern itself—evidence in, structured disagreement in the middle, useful synthesis out.

It turns out four AIs agreeing instantly is less reassuring than four AIs disagreeing for useful reasons.

## What I learned

Different models really do surface different assumptions, but the value disappears quickly without structure. The synthesis format, evidence quality, and dissent stage matter more than simply adding another provider.

I also learned that a reusable AI system needs operational boundaries early. Cost limits, retries, provider failures, and reproducibility are not glamorous, but neither is discovering that your fantasy trade discussion accidentally became a tiny cloud-computing bill.
