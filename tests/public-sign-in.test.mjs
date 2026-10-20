import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// Test the production HTML, including Astro rendering, on every public route.
// Run npm run build before this test so dist reflects the current source.
const pages = await readdir(new URL('../dist/', import.meta.url), { recursive: true });
const routes = pages.filter((path) => path.endsWith('.html') && !path.startsWith('admin/'));
assert.ok(routes.includes('index.html'), 'Build the public site before running these tests');
const text = (html) => html.replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const links = (html) => [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
  .map(([, href, label]) => [text(label), href]);
const primary = [
  ['Projects', '/projects'], ['AI Agents', '/ai-agents'],
  ['Austin Favorites', '/austin-favorites'], ['About', '/about'], ['Newsletter', '/newsletter'],
];

for (const route of routes) {
  const html = await readFile(new URL(`../dist/${route}`, import.meta.url), 'utf8');
  const header = html.match(/<header\b[^>]*class="site-header"[^>]*>[\s\S]*?<\/header>/)?.[0];
  test(`${route}: public header destinations and accessible Sign In entries`, () => {
    assert.ok(header, 'Shared public header exists');
    const menus = [...header.matchAll(/<ul\b[^>]*class="sign-in-options"[^>]*>([\s\S]*?)<\/ul>/g)];
    assert.equal(menus.length, 2, 'Desktop and mobile Sign In lists');
    for (const [list, content] of menus) {
      assert.match(list, /aria-label="Sign In options"/);
      const entries = [...content.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((entry) => entry[1]);
      assert.equal(entries.length, 2);
      assert.equal(text(entries[0]), 'Member Sign In Coming Soon');
      assert.match(entries[0], /^<span\b[^>]*aria-disabled="true"/);
      assert.doesNotMatch(entries[0], /<(?:a|button|input)\b|tabindex|onclick|href=/i);
      assert.deepEqual(links(entries[1]), [['Employee Sign In', 'https://owner.bigsoxstudios.com/']]);
      assert.doesNotMatch(entries[1], /target=/, 'Employee link stays in this window');
    }
    assert.match(header, /<details\b[^>]*class="sign-in-menu"[^>]*>\s*<summary[^>]*>Sign In /);
    assert.match(header, /<summary\b[^>]*aria-label="Navigation"/);
    assert.match(header, /aria-label="Toggle color theme"/);
    assert.doesNotMatch(header, /<(?:form|input|iframe)\b|role="menu"|aria-expanded=/i);
    // The complete destination allowlist also prevents staging/private shortcuts.
    assert.deepEqual(links(header), [
      ['Big Sox Studios', '/'], ...primary, ['Members ↗', '/members'],
      ['Employee Sign In', 'https://owner.bigsoxstudios.com/'],
      ...primary.map(([label, href]) => [`${label}↗`, href]),
      ['Employee Sign In', 'https://owner.bigsoxstudios.com/'],
    ]);
    for (const name of ['Primary navigation', 'Mobile navigation']) {
      const nav = header.match(new RegExp(`<nav\\b[^>]*aria-label="${name}"[^>]*>([\\s\\S]*?)<\\/nav>`));
      assert.ok(nav, `${name} retains its accessible label`);
      assert.deepEqual(links(nav[1]).slice(0, primary.length)
        .map(([label, href]) => [label.replace(/↗$/, ''), href]), primary);
    }
    assert.match(header, /aria-label="Members area — information and invitations"/);
  });
}

test('CMS editor is copied unchanged into the build', async () => {
  assert.equal(
    await readFile(new URL('../dist/admin/index.html', import.meta.url), 'utf8'),
    await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8'),
  );
});
