# Public header regression tests

Run the existing validation gates and the dependency-free Node tests:

```sh
npm run lint
npm run check
npm run build
node --test tests/public-sign-in.test.mjs
```

The tests inspect freshly built HTML on every public route. They check the exact
Sign In entries and destination, disabled member placeholder, same-window link,
accessible labels, absence of header authentication forms, and preserved primary
navigation, Members CTA, and theme control. Rebuild before testing source changes.

For browser review, check desktop and 320px mobile layouts in both themes. Use
Enter/Space to toggle the native disclosure, Tab to reach Employee Sign In, and
Escape to close and restore focus. Also check outside click, focus leaving the
menu, layout changes, short-screen scrolling, reduced motion, and no horizontal
overflow. Native details/summary supplies expanded/collapsed semantics without
JavaScript; JavaScript adds dismissal behavior. Safari and screen-reader review
should be included before release where those environments are available.

Local verification for this change: lint, Astro check, production build, and all
15 Node tests passed (14 public pages plus the unchanged CMS copy). Chromium
could not launch because the environment lacks `libatk-1.0.so.0`; visual,
responsive, Safari/touch, and screen-reader checks remain unverified.

The existing ESLint configuration can also try to parse generated
`.astro/content.d.ts` after a build. For repeated lint runs with generated files
present, use `npm run lint -- --ignore-pattern '.astro/**'`.
