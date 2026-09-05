import {writeFileSync} from 'node:fs';
const targets=await(await fetch('http://127.0.0.1:9333/json/list')).json();
const target=targets.find(t=>t.type==='iframe'&&t.url.startsWith('http://127.0.0.1:'));
if(!target)throw Error('Harness iframe missing');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
const expression=`(()=>{const controls=[...document.querySelectorAll('button,[role="tab"],select')].map(e=>[e.innerText,e.getAttribute('aria-label'),e.title].filter(Boolean).join(' ')); const text=document.body.innerText+' '+controls.join(' '); return {knowledge:/知识库/.test(text),code:/代码库/.test(text),workspaceDropdown:!!document.querySelector('[class$="_workspaceTitle"]')?.closest('button[aria-expanded]'),browserTarget:controls.some(t=>/工作目标上下文/.test(t)),controls};})()`;
ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id!==1)return;const result=m.result?.result?.value;console.log(JSON.stringify(result,null,2));writeFileSync('output/sidebar-repro-result.json',JSON.stringify(result,null,2));ws.close();if(!result?.knowledge||!result?.code||!result?.workspaceDropdown||!result?.browserTarget)process.exitCode=1});
setTimeout(()=>{ws.close();process.exitCode=1},10000).unref();
