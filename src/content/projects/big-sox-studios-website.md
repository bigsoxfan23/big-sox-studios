---
title: "Big Sox Studios Website"
slug: "big-sox-studios-website"
category: "Web"
status: "In Progress"
summary: "The site you are looking at: a public home for projects, experiments, Austin favorites, AI systems, and ideas worth sharing."
heroMedia:
  src: "/projects/placeholders/website.svg"
  alt: "Abstract browser layout illustration representing the Big Sox Studios website"
timeline:
  - label: "Website HQ and public-site direction established"
    date: "2026-09-28"
  - label: "Foundation deployed"
    date: "2026-09-29"
  - label: "Homepage completed"
    date: "2026-09-29"
  - label: "Production brand assets and Socket integrated"
    date: "2026-09-29"
  - label: "Projects Clean Grid launched"
    date: "2026-09-29"
  - label: "Editorial Case Studies begin"
    date: "2026-09-29"
learnings:
  - "A strong content and visual system makes it easier to add personality without turning every page into a different website."
  - "Keeping the public site static by default creates a useful security boundary as more private AI projects are showcased."
  - "Building in bounded batches makes it easier to review the real site instead of making every design decision in the abstract."
---
## The idea

Big Sox Studios is the public home for projects, experiments, recommendations, AI systems, and ideas worth sharing. The goal is a site that feels like a small creative studio rather than a résumé with a navigation bar.

The visual direction mixes a warm editorial feel with a restrained futuristic workshop. That gives very different subjects—AI agents, a GTA companion app, Austin favorites, a home lab—a common home without pretending they are all the same kind of project.

## What it does

The site is built with Astro and generated primarily as static content. GitHub is the source of truth, Cloudflare handles deployment, and local content collections keep projects structured without adding a CMS or database that the site does not need.

The homepage introduces the studio, Projects provides a searchable and filterable shelf of work, and these Editorial Case Studies give individual projects room to explain the idea, what they do, why they matter, their timeline, and what I learned.

The brand system includes the Big Sox Studios logo and Socket, the sock-corgi mascot. Socket appears selectively, because even a very good mascot does not need to attend every meeting.

## Why it matters

I wanted one durable public place where projects could live outside individual chats, repositories, dashboards, and notes. It should be understandable to someone who knows nothing about the private systems behind it while still showing that the projects are real and evolving.

Keeping the public site mostly static also creates a clean security boundary. Private agents and infrastructure can be represented here without turning the website into a control panel for them.

## What I learned

The strongest design decisions have been the ones that make later decisions easier: a consistent visual system, reusable page patterns, structured content, and a clear boundary between public storytelling and private operations.

Building in batches has helped too. Seeing each section on a real phone is much more useful than debating every possible detail beforehand. Websites, apparently, are more informative when they exist.
