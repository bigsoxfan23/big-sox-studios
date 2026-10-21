import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createWorker} from '../membership/worker.mjs';
const source=readFileSync(new URL('../src/pages/members/request.astro',import.meta.url),'utf8');
const script=source.match(/<script>([\s\S]*?)<\/script>/)[1];
test('native form fallback posts to same-origin API without a query and fails closed before storage access',async()=>{
 const form=source.match(/<form\b[^>]*\bid="membership-request"[^>]*>/)[0];
 const method=form.match(/\bmethod="([^"]+)"/)?.[1];
 const action=form.match(/\baction="([^"]+)"/)?.[1];
 assert.equal(method,'post');assert.equal(action,'/api/membership/requests');
 assert.doesNotMatch(source,/\bformmethod\s*=|\bformaction\s*=/i);
 const origin='https://bigsoxstudios.com',url=new URL(action,origin);
 assert.equal(url.origin,origin);assert.equal(url.search,'');
 const fields={name:'Synthetic Visitor',email:'visitor@example.test',reason:'Synthetic reason',acknowledgement:'on'};
 const request=new Request(url,{method,headers:{Origin:origin,'Sec-Fetch-Site':'same-origin'},body:new URLSearchParams(fields)});
 assert.equal(request.method,'POST');assert.match(request.headers.get('Content-Type'),/^application\/x-www-form-urlencoded\b/);
 let storageAccesses=0;
 const response=await createWorker().fetch(request,{get MEMBERSHIP_DB(){storageAccesses++;throw Error('storage must not be accessed');}});
 assert.equal(response.status,415);assert.equal(storageAccesses,0);
 assert.equal(response.headers.get('Cache-Control'),'no-store');
 const message=await response.text();for(const key of ['name','email','reason'])assert.ok(!message.includes(fields[key]));
});
function fixture({token='synthetic-token',response=Response.json({message:'Generic confirmation'}),configured=true}={}) {
 let handler, resets=0,focus=0,sent=0;
 class Form { dataset={configured:String(configured)}; addEventListener(_name,fn){handler=fn;} reportValidity(){return true;} reset(){resets++;} }
 class Button {disabled=false;textContent='Send';}
 class Element {textContent='';focus(){focus++;}}
 const form=new Form(),button=new Button(),result=new Element();
 const fields={name:'Synthetic',email:'visitor@example.test',reason:'Synthetic reason',acknowledgement:'on','cf-turnstile-response':token};
 runInNewContext(script,{document:{querySelector:selector=>({'#membership-request':form,'#request-submit':button,'#request-result':result})[selector]},HTMLFormElement:Form,HTMLButtonElement:Button,HTMLElement:Element,
  FormData:class {get(key){return fields[key];}},fetch:async()=>{sent++;if(response instanceof Error)throw response;return response;},AbortSignal,window:{turnstile:{reset(){}}}});
 return {button,result,get resets(){return resets;},get sent(){return sent;},get focus(){return focus;},submit:()=>handler({preventDefault(){}})};
}
test('client requires security token and prevents disabled unconfigured form submission',async()=>{
 const f=fixture({token:''});await f.submit();assert.equal(f.sent,0);assert.match(f.result.textContent,/security check/);assert.equal(f.focus,1);
 const unavailable=fixture({configured:false});await unavailable.submit();assert.equal(unavailable.sent,0);
});
for(const response of [new Response('unavailable',{status:503}),Error('network'),Response.json({unexpected:'shape'})])
 test('client failure keeps details, enables retry, never reports false success',async()=>{const f=fixture({response});await f.submit();assert.equal(f.resets,0);assert.equal(f.button.disabled,false);assert.match(f.result.textContent,/could not confirm/);assert.equal(f.focus,1);});
test('confirmed client success clears personal fields and presents generic text safely',async()=>{const f=fixture({response:Response.json({message:'<synthetic confirmation>'})});await f.submit();assert.equal(f.resets,1);assert.equal(f.button.disabled,true);assert.equal(f.result.textContent,'<synthetic confirmation>');assert.equal(f.focus,1);});
test('request theme toggle neither reads nor writes localStorage, including on click',()=>{
 const source=readFileSync(new URL('../src/components/ThemeToggle.astro',import.meta.url),'utf8');const script=source.match(/<script is:inline>(.*?)<\/script>/s)[1];let click;
 const root={dataset:{}};const button={dataset:{persistTheme:'false'},addEventListener(_name,fn){click=fn;}};
 const context={document:{documentElement:root,querySelector:()=>button},matchMedia:()=>({matches:false})};Object.defineProperty(context,'localStorage',{get(){throw Error('storage used');}});
 runInNewContext(script,context);assert.equal(root.dataset.theme,'light');click();assert.equal(root.dataset.theme,'dark');
});
