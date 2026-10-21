import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
// Astro can inline small module scripts. Hash the final emitted bytes, rather
// than source bytes, so the request form and shared navigation work under CSP.
export default function membershipHeaders() {
 return {name:'membership-request-csp',hooks:{'astro:build:done':async({dir})=>{
  const html=await readFile(new URL('members/request/index.html',dir),'utf8');
  const hashes=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
   .map(([,script])=>`'sha256-${createHash('sha256').update(script).digest('base64')}'`);
  const path=new URL('_headers',dir),headers=await readFile(path,'utf8');
  await writeFile(path,headers.replace(/script-src [^;]+;/,`script-src 'self' https://challenges.cloudflare.com ${[...new Set(hashes)].join(' ')};`));
 }}};
}
