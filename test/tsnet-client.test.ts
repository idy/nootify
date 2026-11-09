import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { embeddedEnvironment, TsnetClient } from '../src/tsnet-client.js';
import { assertMode } from './platform-fixtures.js';

async function fixture(t: TestContext, body: string, announceReady = true) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-tsnet-rpc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'helper.mjs');
  const handshake = announceReady ? `process.stdout.write(JSON.stringify({id:0,result:{ready:true}})+'\\n');\n` : '';
  await writeFile(binary, `${handshake}${body}`);
  const state = join(directory, 'private-node');
  const client = new TsnetClient(state, { file: process.execPath, args: [binary] });
  t.after(() => client.stop());
  return { client, state, directory };
}
const standard = `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2); const state = args[args.indexOf('--state-dir') + 1];
const input = createInterface({input:process.stdin});
input.on('line', line => { const req=JSON.parse(line); const result = req.method==='status' ? { BackendState:'NeedsLogin', AuthURL:'https://login.tailscale.com/a/Fixture123', args, env:process.env } : req.method==='whois' ? { UserProfile:{LoginName:'owner@example.com'},ip:req.ip } : {ok:true};
setTimeout(()=>process.stdout.write(JSON.stringify({id:req.id,result})+'\\n'), req.method==='status'?10:0); });
input.on('close',()=>{writeFileSync(state+'/closed','EOF');process.exit(0);});`;

test('the embedded helper environment excludes ambient keys, OAuth, control servers and daemon paths', () => {
  const env = embeddedEnvironment({ HOME:'/private/home', PATH:'/usr/bin', TS_AUTHKEY:'secret', TS_AUTH_KEY:'secret', TS_CLIENT_SECRET:'oauth', TS_CLIENT_ID:'client', TS_CONTROL_URL:'https://elsewhere.test', TSNET_FORCE_LOGIN:'1', TAILSCALE_BIN:'/host/client', NODE_OPTIONS:'--import=evil' });
  assert.deepEqual(env, { HOME:'/private/home', PATH:'/usr/bin' });
});

test('private stdio RPC preserves reply IDs, supplies an isolated state directory, and closes on EOF', async t => {
  const {client,state}=await fixture(t,standard); let exits=0;
  t.mock.property(process,'env',{...process.env,TS_AUTHKEY:'ambient-secret'});
  await client.start('tcp://127.0.0.1:12345',()=>{exits++;});
  const [status, whois] = await Promise.all([client.status(),client.whois('100.64.0.9')]) as any[];
  assert.equal(status.BackendState,'NeedsLogin'); assert.equal(whois.ip,'100.64.0.9');
  assert.ok(status.args.includes(state)); assert.ok(status.args.includes('nootify')); assert.ok(status.args.includes('tcp://127.0.0.1:12345'));
  assert.equal(status.env.TS_AUTHKEY,undefined); await assertMode(state,0o700);
  await client.login(); await client.logout(); await client.stop();
  assert.equal(await readFile(join(state,'closed'),'utf8'),'EOF'); assert.equal(exits,0,'intentional stop is not a crash');
  await assert.rejects(client.status(),/embedded_client_stopped/);
});

test('helper errors do not expose arbitrary private text', async t => {
  const {client}=await fixture(t,`import {createInterface} from 'node:readline';const input=createInterface({input:process.stdin});input.on('line',line=>{const req=JSON.parse(line);console.log(JSON.stringify({id:req.id,error:'private https://login.tailscale.com/a/Secret123'}));});input.on('close',()=>process.exit());`);
  await client.start('tcp://127.0.0.1:12345',()=>{}); await assert.rejects(client.status(),{message:'embedded_request_failed'});
});

test('stopping rejects outstanding RPCs instead of hanging on an unresponsive helper', async t => {
  const {client}=await fixture(t,`process.stdin.resume();process.stdin.on('end',()=>process.exit());`);
  await client.start('tcp://127.0.0.1:12345',()=>{});
  const pending=assert.rejects(client.status(),/embedded_client_stopped/); await client.stop(); await pending;
});

test('malformed helper output terminates the client and fails pending requests safely', async t => {
  const {client}=await fixture(t,`process.stdin.on('data',()=>process.stdout.write('not-json\\n'));`);
  await client.start('tcp://127.0.0.1:12345',()=>{}); await assert.rejects(client.status(),/embedded_protocol_error/);
});

test('helper startup waits for readiness and preserves allowlisted failure causes', async t => {
  const {client}=await fixture(t,`process.stderr.write('private https://login.tailscale.com/a/Secret123');process.stdout.write(JSON.stringify({id:0,error:'state_locked'})+'\\n');process.exit(1);`, false);
  await assert.rejects(client.start('tcp://127.0.0.1:12345',()=>{}), { message:'state_locked' });
  await assert.rejects(client.status(), /embedded_client_stopped/);
});

test('a child that exits before readiness never counts as a successful startup', async t => {
  const {client}=await fixture(t,`process.exit(0);`, false);
  await assert.rejects(client.start('tcp://127.0.0.1:12345',()=>{}), /embedded_client_stopped/);
});

test('relative service state directories are made absolute before crossing the helper boundary', async t => {
  const {directory}=await fixture(t,standard);
  const path=join(directory,'relative-state'); const client=new TsnetClient(relative(process.cwd(),path),{file:process.execPath,args:[join(directory,'helper.mjs')]});
  t.after(()=>client.stop()); await client.start('tcp://127.0.0.1:12345',()=>{});
  const status=await client.status() as {args:string[]};
  assert.equal(status.args[status.args.indexOf('--state-dir')+1],path);
});

test('a symlink cannot redirect private node state or change another directory permissions', async t => {
  const {client,state,directory}=await fixture(t,standard);
  const other=join(directory,'other-state');await mkdir(other);await chmod(other,0o755);await symlink(other,state,process.platform==='win32'?'junction':'dir');
  await assert.rejects(client.start('tcp://127.0.0.1:12345',()=>{}),/state_unavailable/);
  await assertMode(other,0o755);
});

test('a missing embedded helper never starts an installed Tailscale client', async t => {
  const dir=await mkdtemp(join(tmpdir(),'nootify-missing-helper-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const client=new TsnetClient(join(dir,'state'),join(dir,'missing-helper'));t.after(()=>client.stop());
  await assert.rejects(client.start('tcp://127.0.0.1:12345',()=>{}),/embedded_client_missing/);
});

test('private transport wrappers preserve endpoint network and token separately from reply IDs', async t => {
  const endpoint={network:process.platform==='win32'?'npipe':'unix',address:process.platform==='win32'?String.raw`\\.\pipe\nootify-tunnel-`+'a'.repeat(32):'/synthetic/nootify-tunnel.sock',token:'a'.repeat(64)};
  const {client}=await fixture(t,`import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin});const requests=[];const endpoint=${JSON.stringify(endpoint)};
input.on('line',line=>{const req=JSON.parse(line);requests.push(req);
const result=req.method==='tunnel'?{id:'tunnel-1',...endpoint}:req.method==='publish'?{port:req.port}:req.method==='status'?requests:{ok:true};
setTimeout(()=>process.stdout.write(JSON.stringify({id:req.id,result})+'\\n'),req.method==='tunnel'?10:0);});
input.on('close',()=>process.exit());`);
  await client.start('tcp://127.0.0.1:12345',()=>{});
  const [tunnel,publication]=await Promise.all([client.tunnel('[fd7a:115c:a1e0::2]:7443'),client.publish(7443,'127.0.0.1:54321')]);
  assert.deepEqual(tunnel,{id:'tunnel-1',...endpoint});
  assert.deepEqual(publication,{port:7443});
  assert.equal(await client.closeTunnel(tunnel.id),undefined);
  assert.equal(await client.unpublish(publication.port),undefined);
  assert.deepEqual(await client.status(),[
    {id:1,method:'tunnel',address:'[fd7a:115c:a1e0::2]:7443'},
    {id:2,method:'publish',port:7443,target:'127.0.0.1:54321'},
    {id:3,method:'close_tunnel',tunnel_id:'tunnel-1'},
    {id:4,method:'unpublish',port:7443},
    {id:5,method:'status'},
  ]);
});

test('tunnel leases reject missing malformed and uppercase authentication tokens without exposing helper data', async t => {
  const endpoint={network:process.platform==='win32'?'npipe':'unix',address:process.platform==='win32'?String.raw`\\.\pipe\nootify-tunnel-`+'a'.repeat(32):'/synthetic/nootify-tunnel.sock'};
  const {client}=await fixture(t,`import {createInterface} from 'node:readline';const input=createInterface({input:process.stdin});
const tokens=[undefined,'private-secret-value','A'.repeat(64),'b'.repeat(64)];const endpoint=${JSON.stringify(endpoint)};
input.on('line',line=>{const req=JSON.parse(line);const result={id:'lease',...endpoint,token:tokens.shift()};process.stdout.write(JSON.stringify({id:req.id,result})+'\\n');});input.on('close',()=>process.exit());`);
  await client.start('tcp://127.0.0.1:12345',()=>{});
  for(let i=0;i<3;i++)await assert.rejects(client.tunnel('100.64.0.2:7443'),{message:'embedded_protocol_error'});
  assert.equal((await client.tunnel('100.64.0.2:7443')).token,'b'.repeat(64));
});

for(const platform of ['darwin','win32'] as const){
  test(`${platform}: tunnel endpoints require the matching private IPC network without TCP fallback`,async t=>{
    const pipe=String.raw`\\.\pipe\nootify-tunnel-`+'b'.repeat(32);
    const valid=platform==='win32'?{network:'npipe',address:pipe}:{network:'unix',address:'/synthetic/owner/tunnel.sock'};
    const invalid=platform==='win32'
      ?[{network:'tcp',address:'127.0.0.1:43210'},{network:'unix',address:'/tmp/tunnel.sock'},{network:'npipe',address:pipe+'0'},{network:'npipe',address:pipe.toUpperCase()}]
      :[{network:'tcp',address:'127.0.0.1:43210'},{network:'npipe',address:pipe},{network:'unix',address:'relative.sock'},{network:'unix',address:'/tmp/invalid\0.sock'}];
    const {client}=await fixture(t,`import {createInterface} from 'node:readline';const input=createInterface({input:process.stdin});const endpoints=${JSON.stringify([...invalid,valid])};
input.on('line',line=>{const req=JSON.parse(line);process.stdout.write(JSON.stringify({id:req.id,result:{id:'lease',token:'a'.repeat(64),...endpoints.shift()}})+'\\n');});input.on('close',()=>process.exit());`);
    await client.start('tcp://127.0.0.1:12345',()=>{});
    t.mock.property(process,'platform',platform);
    try{for(const _endpoint of invalid)await assert.rejects(client.tunnel('100.64.0.2:7443'),{message:'embedded_protocol_error'});
      assert.deepEqual(await client.tunnel('100.64.0.2:7443'),{id:'lease',token:'a'.repeat(64),...valid});
    }finally{t.mock.restoreAll();}
  });
}

test('TCP transport errors preserve fixed codes and redact arbitrary helper text', async t => {
  const {client}=await fixture(t,`import {createInterface} from 'node:readline';const input=createInterface({input:process.stdin});
input.on('line',line=>{const req=JSON.parse(line);const error=req.method==='tunnel'?'invalid_address':req.method==='publish'?'listener_failed':'private https://login.tailscale.com/a/Secret123';
process.stdout.write(JSON.stringify({id:req.id,error})+'\\n');});input.on('close',()=>process.exit());`);
  await client.start('tcp://127.0.0.1:12345',()=>{});
  await assert.rejects(client.tunnel('localhost:7443'),{message:'invalid_address'});
  await assert.rejects(client.publish(7443,'127.0.0.1:54321'),{message:'listener_failed'});
  await assert.rejects(client.closeTunnel('1'),{message:'embedded_request_failed'});
  await assert.rejects(client.unpublish(7443),{message:'embedded_request_failed'});
});

test('stop rejects outstanding TCP transport RPCs and later calls fail safely', async t => {
  const {client}=await fixture(t,`process.stdin.resume();process.stdin.on('end',()=>process.exit());`);
  await client.start('tcp://127.0.0.1:12345',()=>{});
  const pending=[client.tunnel('node.tail.ts.net:7443'),client.publish(7443,'127.0.0.1:54321'),client.closeTunnel('1'),client.unpublish(7443)]
    .map(request=>assert.rejects(request,{message:'embedded_client_stopped'}));
  await client.stop();await Promise.all(pending);
  await assert.rejects(client.tunnel('100.64.0.2:7443'),{message:'embedded_client_stopped'});
  await assert.rejects(client.publish(7443,'127.0.0.1:54321'),{message:'embedded_client_stopped'});
});
