import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { embeddedEnvironment, TsnetClient } from '../src/tsnet-client.js';

async function fixture(t: TestContext, body: string, announceReady = true) {
  const directory = await mkdtemp(join(tmpdir(), 'nootify-tsnet-rpc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'helper.mjs');
  const handshake = announceReady ? `process.stdout.write(JSON.stringify({id:0,result:{ready:true}})+'\\n');\n` : '';
  await writeFile(binary, `#!${process.execPath}\n${handshake}${body}`, { mode: 0o700 });
  const state = join(directory, 'private-node');
  const client = new TsnetClient(state, binary);
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
  assert.equal(status.env.TS_AUTHKEY,undefined); assert.equal((await stat(state)).mode&0o777,0o700);
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
  const path=join(directory,'relative-state'); const client=new TsnetClient(relative(process.cwd(),path),join(directory,'helper.mjs'));
  t.after(()=>client.stop()); await client.start('tcp://127.0.0.1:12345',()=>{});
  const status=await client.status() as {args:string[]};
  assert.equal(status.args[status.args.indexOf('--state-dir')+1],path);
});

test('a symlink cannot redirect private node state or change another directory permissions', async t => {
  const {client,state,directory}=await fixture(t,standard);
  const other=join(directory,'other-state');await mkdir(other);await chmod(other,0o755);await symlink(other,state,'dir');
  await assert.rejects(client.start('tcp://127.0.0.1:12345',()=>{}),/state_unavailable/);
  assert.equal((await stat(other)).mode&0o777,0o755);
});

test('a missing embedded helper never starts an installed Tailscale client', async t => {
  const dir=await mkdtemp(join(tmpdir(),'nootify-missing-helper-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const client=new TsnetClient(join(dir,'state'),join(dir,'missing-helper'));t.after(()=>client.stop());
  await assert.rejects(client.start('tcp://127.0.0.1:12345',()=>{}),/embedded_client_missing/);
});
