import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('offline smoke is credential-free, deterministic and isolates inherited daemon settings',{timeout:20000},async()=>{
 const {stdout}=await exec(process.execPath,['scripts/smoke.mjs'],{
  cwd:process.cwd(),timeout:15000,
  env:{...process.env,SMOKE_LIVE:'0',PI_COFFEE_PI_BIN:'/no/real/pi-must-be-used',PI_COFFEE_TOKEN:'inherited-token',PI_COFFEE_HOST:'192.0.2.1',PI_COFFEE_WORKSPACE_ROOT:'/no/shared-worktrees',PI_COFFEE_AUTO_CLEAN:'0'}
 });
 assert.match(stdout,/SMOKE OK/);assert.doesNotMatch(stdout,/FAIL /);
});
