import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicApi, type PublicDependencies, type PublicConfig } from './route.js';
import { encode, decode } from '../../src/x402/server.js';
const taskId='00000000-0000-0000-0000-000000000123';
const origin='https://mesh402.example';
const accepted={scheme:'exact',network:'hedera:testnet',amount:'100000',asset:'0.0.0',payTo:'0.0.456',maxTimeoutSeconds:120,extra:{feePayer:'0.0.789'}} as const;
const inspected={transactionId:'0.0.789@1234567890.000000001',transactionIdAccountId:'0.0.789',hasNonTransferOperations:false,tokenTransfers:{},hbarTransfers:[{accountId:'0.0.123',amount:'-100000'},{accountId:'0.0.456',amount:'100000'}]};
const payment=()=>({x402Version:2,resource:{url:origin+'/api/v1/generate'},accepted:structuredClone(accepted),payload:{transaction:'mock-caller-signed-transaction'}});
const spec = JSON.parse(await readFile(new URL('../../frontend/public/openapi.json', import.meta.url), 'utf8'));
const operation = spec.paths['/api/v1/generate'].post;
// Contract checks for this document's schema subset; full OpenAPI lint is separate.
function matchesSchema(value: any, schema: any): void {
  if (schema.$ref) return matchesSchema(value, spec.components.schemas[schema.$ref.split('/').at(-1)]);
  if (schema.oneOf) {
    assert.equal(schema.oneOf.filter((candidate: any) => { try { matchesSchema(value, candidate); return true; } catch { return false; } }).length, 1);
    return;
  }
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = [schema.type].flat();
  assert.ok(types.includes(type) || (types.includes('integer') && Number.isInteger(value)), `Unexpected ${type}`);
  if (schema.enum) assert.ok(schema.enum.some((item: any) => Object.is(item, value)));
  if (type === 'object') {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `Missing ${key}`);
    if (schema.additionalProperties === false) assert.ok(Object.keys(value).every(key => key in schema.properties), 'Undocumented response field');
    for (const [key, item] of Object.entries(value)) if (schema.properties[key]) matchesSchema(item, schema.properties[key]);
  }
  if (type === 'array') {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems);
    value.forEach((item: any) => matchesSchema(item, schema.items));
  }
  if (type === 'string') {
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern));
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength);
    if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength);
    if (schema.format === 'uri') assert.ok(new URL(value).protocol);
  }
  if (type === 'number' && schema.minimum !== undefined) assert.ok(value >= schema.minimum);
}
test('public OpenAPI documents only the existing caller-paid operation and prompt contract', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.info.title && spec.info.version);
  assert.deepEqual(spec.servers, [{url: 'https://mesh402.onrender.com'}]);
  assert.deepEqual(Object.keys(spec.paths), ['/api/v1/generate']);
  assert.deepEqual(Object.keys(spec.paths['/api/v1/generate']), ['post']);
  assert.equal(operation.parameters[0].name, 'PAYMENT-SIGNATURE');
  assert.equal(operation.parameters[0].required, false);
  assert.deepEqual(operation.security, []);
  assert.ok(operation.responses['402'].headers['PAYMENT-REQUIRED']);
  assert.ok(operation.responses['200'].headers['PAYMENT-RESPONSE']);
  const request = operation.requestBody.content['application/json'].schema;
  matchesSchema({prompt: 'robot'}, request);
  for (const invalid of [{}, {prompt: ''}, {prompt: '  '}, {prompt: 42}, {prompt: 'x'.repeat(2001)}, {prompt: 'robot', extra: true}]) {
    assert.throws(() => matchesSchema(invalid, request));
  }
});
async function fixture(overrides: Partial<PublicDependencies>={}, configOverrides: Partial<PublicConfig>={}) {
  const dataDir=await mkdtemp(resolve(tmpdir(),'mesh402-public-'));
  const calls={discover:0,verify:0,settle:0,generate:0,persist:0};
  const deps:PublicDependencies={
    discover:async()=>{calls.discover++;return structuredClone(accepted);},
    inspect:value=>{if(value!=='mock-caller-signed-transaction')throw new Error('Invalid serialized tx');return structuredClone(inspected) as any;},
    facilitator:async path=>{if(path==='/verify'){calls.verify++;return {isValid:true,payer:'0.0.123'};}if(path==='/settle'){calls.settle++;return {success:true,network:'hedera:testnet',payer:'0.0.123',transaction:inspected.transactionId};}throw new Error('Unexpected network operation');},
    generate:async(prompt,options)=>{calls.generate++;assert.equal(prompt,'robot');options!.onResponse!('/generation/text-to-model',{code:0,data:{task_id:taskId}});return {taskId,glbUrl:'https://temporary.invalid/model.glb',consumedCredit:20};},
    persist:async()=>{calls.persist++;const file=resolve(dataDir,`${taskId}.glb`);await writeFile(file,'mock-glb-file');return {localGlbPath:file,glbBytes:13};},
    ...overrides,
  };
  const config:PublicConfig={enabled:true,origin,recipient:'0.0.456',dataDir,maxGenerations:5,maxConcurrent:1,providerReady:true,...configOverrides};
  const servers:ReturnType<typeof createServer>[]=[];
  async function start(){const route=await createPublicApi(config,deps);const server=createServer(async(req,res)=>{if(!await route(req,res)){res.writeHead(404);res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');servers.push(server);return `http://127.0.0.1:${(server.address() as any).port}`;}
  const base=await start();
  const post=async(value?:any,baseUrl=base)=>{
    const response = await fetch(baseUrl+'/api/v1/generate',{method:'POST',headers:{'Content-Type':'application/json',...(value===undefined?{}:{'PAYMENT-SIGNATURE':typeof value==='string'?value:encode(value)})},body:JSON.stringify({prompt:'robot'})});
    const documented = operation.responses[String(response.status)];
    assert.ok(documented, `Undocumented HTTP ${response.status}`);
    matchesSchema(await response.clone().json(), documented.content['application/json'].schema);
    return response;
  };
  return {dataDir,calls,post,base,start,async close(){for(const server of servers){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await rm(dataDir,{recursive:true,force:true});}};
}

test('unpaid caller gets canonical 402, malformed/mismatched payments never reach settlement or generation',async()=>{
  const old=process.env.HEDERA_PAYER_PRIVATE_KEY;process.env.HEDERA_PAYER_PRIVATE_KEY='operator-key-must-never-be-used';
  const f=await fixture();try{
    const unpaid=await f.post();assert.equal(unpaid.status,402);const offer=await unpaid.json();assert.deepEqual(decode(unpaid.headers.get('payment-required')!),offer);assert.equal(offer.x402Version,2);assert.deepEqual(offer.accepts,[accepted]);
    assert.equal((await f.post('%%%')).status,400);
    for(const [field,value]of [['network','hedera:mainnet'],['payTo','0.0.999'],['amount','100001'],['scheme','upto'],['asset','0.0.777']]){const p:any=payment();p.accepted[field]=value;assert.equal((await f.post(p)).status,400,field);}
    const bad=payment();bad.payload.transaction='invalid';assert.equal((await f.post(bad)).status,400);
    assert.deepEqual(f.calls,{discover:1,verify:0,settle:0,generate:0,persist:0});
    assert.equal((await fetch(f.base+'/demo/live',{method:'POST'})).status,404,'no operator routing in public handler');
  }finally{await f.close();if(old===undefined)delete process.env.HEDERA_PAYER_PRIVATE_KEY;else process.env.HEDERA_PAYER_PRIVATE_KEY=old;}
});

test('successful caller-funded mocked settlement invokes generation once; stable URLs, quota and duplicate guard persist',async()=>{
  const old=process.env.HEDERA_PAYER_PRIVATE_KEY;delete process.env.HEDERA_PAYER_PRIVATE_KEY;
  const f=await fixture();try{
    const r=await f.post(payment());assert.equal(r.status,200);const data=await r.json();assert.equal(data.payer,'0.0.123');assert.equal(data.recipient,'0.0.456');assert.equal(data.assetUrl,`${origin}/api/v1/assets/${taskId}.glb`);assert.ok(!JSON.stringify(data).includes(f.dataDir));assert.ok(!JSON.stringify(data).includes('temporary.invalid'));
    assert.equal(decode(r.headers.get('payment-response')!).success,true);assert.deepEqual(f.calls,{discover:1,verify:1,settle:1,generate:1,persist:1});
    assert.equal((await f.post(payment())).status,409);assert.equal(f.calls.generate,1);
    const state=JSON.parse(await readFile(resolve(f.dataDir,'public-api/state.json'),'utf8'));assert.equal(state.created,1);assert.equal(state.completed,1);assert.equal(state.active,null);
    const restarted=await f.start();assert.equal((await f.post(payment(),restarted)).status,409);
    assert.equal((await fetch(`${restarted}/api/v1/receipts/${taskId}.json`).then(r=>r.json())).taskId,taskId);
    assert.equal(await fetch(`${restarted}/api/v1/assets/${taskId}.glb`).then(r=>r.text()),'mock-glb-file');
  }finally{await f.close();if(old!==undefined)process.env.HEDERA_PAYER_PRIVATE_KEY=old;}
});

test('quota rejects unsigned and paid requests before another settlement',async()=>{
  const f=await fixture({}, {maxGenerations:1});try{
    assert.equal((await f.post(payment())).status,200);
    const r=await f.post();assert.equal(r.status,429);assert.equal((await r.json()).error.code,'quota_exhausted');
    assert.equal((await f.post(payment())).status,429);assert.equal(f.calls.settle,1);assert.equal(f.calls.generate,1);
    const restarted=await f.start();assert.equal((await f.post(undefined,restarted)).status,429);
  }finally{await f.close();}
});

test('concurrent requests cannot settle or generate a second task',async()=>{
  let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);
  let verifies=0,settles=0;
  const f=await fixture({facilitator:async path=>{if(path==='/verify'){verifies++;entered();await gate;return {isValid:true,payer:'0.0.123'};}settles++;return {success:true,network:'hedera:testnet',payer:'0.0.123',transaction:inspected.transactionId};}});
  try{const first=f.post(payment());await started;const second=await f.post(payment());assert.equal(second.status,409);assert.equal((await second.json()).error.code,'generation_in_progress');release();assert.equal((await first).status,200);assert.equal(verifies,1);assert.equal(settles,1);assert.equal(f.calls.generate,1);}finally{release();await f.close();}
});

test('invalid caller signature cannot use an operator key as fallback; 402 and no quota consumption',async()=>{
  const f=await fixture({facilitator:async()=>({isValid:false,invalidReason:'signature_missing'})});try{
    const r=await f.post(payment());assert.equal(r.status,402);assert.equal((await r.json()).error,'payment_verification_failed');assert.ok(r.headers.get('payment-required'));assert.equal(f.calls.generate,0);
    const state=JSON.parse(await readFile(resolve(f.dataDir,'public-api/state.json'),'utf8'));assert.equal(state.created,0);assert.equal(state.active,null);
  }finally{await f.close();}
});

test('creation failure before an observed task reserves capacity; after task creation consumes count; both remain blocked after restart',async()=>{
  for(const taskCreated of [false,true]){
    const f=await fixture({generate:async(_p,options)=>{if(taskCreated)options!.onResponse!('/generation/text-to-model',{code:0,data:{task_id:taskId}});throw new Error('Simulated ambiguous network failure');}});
    try{const r=await f.post(payment());assert.equal(r.status,502);const error=await r.json();assert.equal(error.paid,true);assert.equal(error.retryable,false);const state=JSON.parse(await readFile(resolve(f.dataDir,'public-api/state.json'),'utf8'));assert.equal(state.created,taskCreated?1:0);assert.equal(state.active.phase,'ambiguous');const restarted=await f.start();const retry=await f.post(payment(),restarted);assert.equal(retry.status,409);assert.equal((await retry.json()).error.code,'reconciliation_required');}finally{await f.close();}
  }
});

test('settlement ambiguity never reaches Tripo; disabled API never asks for payment',async()=>{
  const f=await fixture({facilitator:async path=>{if(path==='/verify')return {isValid:true,payer:'0.0.123'};throw new Error('Settlement timed out');}});
  try{const r=await f.post(payment());assert.equal(r.status,502);assert.equal((await r.json()).paid,'unknown');assert.equal(f.calls.generate,0);assert.equal((await f.post()).status,409);}finally{await f.close();}
  const off=await fixture({}, {enabled:false});try{assert.equal((await off.post()).status,503);assert.equal(off.calls.discover,0);assert.equal(off.calls.generate,0);}finally{await off.close();}
});
