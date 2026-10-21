import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import config from '../astro.config.mjs';

// Like the public route tests, run after npm run build.
test('Astro site and generated canonical metadata use the public production origin', async () => {
  assert.equal(config.site, 'https://bigsoxstudios.com');
  const files = await readdir(new URL('../dist/', import.meta.url), { recursive: true });
  assert.ok(files.includes('index.html'), 'Build the public site before running this test');
  let canonicalCount = 0;
  for (const file of files.filter((path) => path.endsWith('.html'))) {
    const html = await readFile(new URL(`../dist/${file}`, import.meta.url), 'utf8');
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] || '';
    assert.doesNotMatch(head, /example\.com/i, `${file}: no placeholder metadata`);
    for (const [, href] of head.matchAll(/<link\b[^>]*rel="canonical"[^>]*href="([^"]*)"[^>]*>/g)) {
      assert.equal(new URL(href).origin, config.site, `${file}: canonical origin`);
      canonicalCount++;
    }
  }
  assert.ok(canonicalCount > 0, 'Inspect actual generated canonical links');
});
