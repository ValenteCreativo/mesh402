import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createBridge } from './bridge.js';
import { storage } from './storage.js';

test('operator gate is route-scoped; replay public; origin and session required; no paid invocation', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'mesh402-gate-'));
  const origin = 'http://localhost:9911';
  const bridge = await createBridge({ origin, dataDir: dir, mode: 'dry-run', secret: 'fixture-operator-credential' });
  const server = createServer(async (req, res) => { if (!await bridge(req,res)) { res.writeHead(404); res.end('separate route'); } });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal((await fetch(url+'/demo/evidence')).status,200);
    assert.equal((await fetch(url+'/api/generate-3d',{method:'POST'})).status,404);
    assert.equal((await fetch(url+'/demo/live',{method:'POST',headers:{origin},body:JSON.stringify({intent:'asset',confirm:true})})).status,401);
    assert.equal((await fetch(url+'/demo/operator/session',{method:'POST',body:'secret=fixture-operator-credential'})).status,403);
    assert.equal((await fetch(url+'/demo/operator/session',{method:'POST',headers:{origin},body:'secret=incorrect'})).status,401);
    const login = await fetch(url+'/demo/operator/session',{method:'POST',headers:{origin},body:'secret=fixture-operator-credential',redirect:'manual'});
    assert.equal(login.status,303); const cookie = login.headers.get('set-cookie')!; assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Strict/);
    const headers = {cookie:cookie.split(';')[0],origin};
    assert.equal((await fetch(url+'/demo/config',{headers}).then(r=>r.json())).operatorAuthorized,true);
    assert.equal((await fetch(url+'/demo/live',{method:'POST',headers:{cookie:headers.cookie,origin:'https://evil.invalid'},body:'{}'})).status,403);
    assert.equal((await fetch(url+'/demo/live',{method:'POST',headers,body:'{}'})).status,400);
    // Claim an interrupted attempt: even a valid session must not start a new CLI.
    const disk = await storage(resolve(dir,'wrapper'),'dry-run'); assert.equal(await disk.claim('fixture'),true);
    const restarted = await createBridge({ origin, dataDir: dir, mode: 'dry-run', secret: 'fixture-operator-credential' });
    const server2 = createServer(async (req,res)=>{await restarted(req,res);}); server2.listen(0,'127.0.0.1'); await once(server2,'listening');
    try {
      const u2=`http://127.0.0.1:${(server2.address() as any).port}`;
      const l2=await fetch(u2+'/demo/operator/session',{method:'POST',headers:{origin},body:'secret=fixture-operator-credential',redirect:'manual'});
      const h2={origin,cookie:l2.headers.get('set-cookie')!.split(';')[0]};
      assert.equal((await fetch(u2+'/demo/operator/state',{headers:h2}).then(r=>r.json())).status,'ambiguous');
      assert.equal((await fetch(u2+'/demo/live',{method:'POST',headers:h2,body:JSON.stringify({confirm:true,intent:'asset'})})).status,409);
    } finally { server2.closeAllConnections(); await new Promise<void>(r=>server2.close(()=>r())); }
  } finally { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); await rm(dir,{recursive:true,force:true}); }
});

test('exclusive claim, completed state and approved registry survive restart', async () => {
  const dir=await mkdtemp(resolve(tmpdir(),'mesh402-state-'));
  try {
    const store=await storage(dir,'dry-run');
    const claims=await Promise.all([store.claim('one'),store.claim('two')]); assert.equal(claims.filter(Boolean).length,1);
    await store.register({taskId:'fixture-task',assetUrl:'/fixture.glb'});
    await store.update({status:'completed',result:{paid:false}});
    const reopened=await storage(dir,'dry-run'); assert.equal(await reopened.claim('again'),false);
    assert.equal(reopened.getState().status,'completed'); assert.equal(reopened.registry['fixture-task'].assetUrl,'/fixture.glb');
    await writeFile(resolve(dir,'live.lock'),'');
    const interrupted=await storage(dir,'live'); assert.equal(interrupted.getState().status,'ambiguous');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('registered public receipts and GLBs survive restart without exposing private files', async () => {
  const dir=await mkdtemp(resolve(tmpdir(),'mesh402-registry-'));
  const task='00000000-0000-0000-0000-000000000001';
  try {
    const stored=await storage(resolve(dir,'wrapper'),'dry-run');
    await writeFile(resolve(dir,`${task}.glb`),'fixture-glb');
    await stored.register({taskId:task,receiptUrl:`/demo/receipts/${task}.json`,assetUrl:`/demo/assets/${task}.glb`});
    const bridge=await createBridge({origin:'http://localhost',dataDir:dir,mode:'dry-run'});
    const server=createServer(async(req,res)=>{if(!await bridge(req,res)){res.writeHead(404);res.end();}});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    try {
      const base=`http://127.0.0.1:${(server.address() as any).port}`;
      assert.equal((await fetch(`${base}/demo/receipts/${task}.json`).then(r=>r.json())).taskId,task);
      assert.equal(await fetch(`${base}/demo/assets/${task}.glb`).then(r=>r.text()),'fixture-glb');
      assert.equal((await fetch(`${base}/demo/assets/00000000-0000-0000-0000-000000000002.glb`)).status,404);
      assert.equal((await fetch(`${base}/demo/receipts/mesh402-agent-receipt.json`)).status,404);
    } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  }finally{await rm(dir,{recursive:true,force:true});}
});
