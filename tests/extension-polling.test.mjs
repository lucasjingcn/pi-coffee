import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('extension polling serializes delivery and acknowledges only successful injection', { timeout: 10000 }, async () => {
  const code = `
    import assert from 'node:assert/strict';
    process.env.PI_COORD_URL='http://coordinator.test';
    process.env.PI_COORD_SESSION_ID='one';
    const handlers=new Map(); let tick; let reads=0; let polls=0; let deliveries=0; let fail=false;
    let releaseInbox; const inboxGate=new Promise(r=>releaseInbox=r);
    let releaseDelivery; const deliveryGate=new Promise(r=>releaseDelivery=r);
    const turn=()=>new Promise(r=>setImmediate(r));
    globalThis.setInterval=(fn)=>{tick=fn;return {unref(){}};};
    globalThis.clearInterval=()=>{};
    globalThis.fetch=async (url,opts)=>{
      assert.ok(opts.signal instanceof AbortSignal);
      const path=new URL(url).pathname;
      if(path==='/internal/inbox'){polls++;if(polls===1)await inboxGate;return {ok:true,text:async()=>JSON.stringify({messages:[{id:'message',from:'sender',kind:'broadcast',text:'hello'}]})};}
      if(path==='/internal/read'){reads++;assert.equal(JSON.parse(opts.body).sessionId,'one');}
      return {ok:true,text:async()=>JSON.stringify({ok:true})};
    };
    const pi={registerTool(){},on(name,fn){handlers.set(name,fn);},async sendUserMessage(){deliveries++;if(fail)throw new Error('failed injection');if(deliveries===1)await deliveryGate;}};
    const extension=(await import('./extensions/pi-coordinator.ts')).default;
    extension(pi);handlers.get('session_start')();
    tick();tick();await turn();assert.equal(polls,1);
    releaseInbox();await turn();assert.equal(deliveries,1);assert.equal(reads,0);
    tick();await turn();assert.equal(polls,1);
    releaseDelivery();await turn();assert.equal(reads,1);
    fail=true;tick();await turn();assert.equal(reads,1);
    fail=false;tick();await turn();assert.equal(reads,2);
    await handlers.get('session_shutdown')();
    console.log('POLLING OK');
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), timeout: 8000 });
  assert.match(stdout, /POLLING OK/);
});
