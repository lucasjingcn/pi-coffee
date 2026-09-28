import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('real filenames new/setTimeout stay protected and non-command words create no locks', { timeout: 10000 }, async () => {
  const cases = [
    { cmd: 'printf x > new && printf y > setTimeout', paths: ['new', 'setTimeout'] },
    { cmd: "printf '%s' tee fake.txt", paths: [] },
    { cmd: "echo sed -i 's/old/new/g' example.txt", paths: [] },
    { cmd: 'cat < input.txt > output.txt', paths: ['output.txt'] },
    { cmd: "printf '%s' '> new' # tee setTimeout", paths: [] },
    { cmd: 'printf x > "a\\q.txt"', paths: ['a/q.txt'] },
    { cmd: '2> err.txt tee out.txt', paths: ['err.txt', 'out.txt'] },
    { cmd: 'cat <<< "text"\nprintf ok > final.txt', paths: ['final.txt'] },
    { cmd: 'tee one.txt > log.txt two.txt', paths: ['one.txt', 'log.txt', 'two.txt'] },
    { cmd: "sed -i 's/a/b/' one.txt 2> err.txt two.txt", paths: ['one.txt', 'err.txt', 'two.txt'] },
  ];
  const code = `
    import assert from 'node:assert/strict';
    process.env.PI_COORD_URL='http://coordinator.test';process.env.PI_COORD_SESSION_ID='one';
    const extension=(await import('./extensions/pi-coordinator.ts')).default;
    for(const c of ${JSON.stringify(cases)}) {
      let hook;let paths=[];
      globalThis.fetch=async(url,opts)=>{
        paths.push(...JSON.parse(opts.body).paths);
        return {ok:true,text:async()=>JSON.stringify({ok:true})};
      };
      extension({registerTool(){},on(n,f){if(n==='tool_call')hook=f;}});
      await hook({toolName:'bash',input:{command:c.cmd}},{cwd:'/worktree'});
      assert.deepEqual([...new Set(paths)].sort(),c.paths.sort(),c.cmd);
    }
    let hook;
    globalThis.fetch=async(url,opts)=>({ok:true,text:async()=>JSON.stringify({ok:false,conflicts:[{path:'/new',sessionId:'other'}]})});
    extension({registerTool(){},on(n,f){if(n==='tool_call')hook=f;}});
    const result=await hook({toolName:'bash',input:{command:'printf real > new'}},{cwd:'/worktree'});
    assert.equal(result.block,true);
    assert.match(result.reason,/other/);
    console.log('REAL TARGETS OK');
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), timeout: 8000 });
  assert.match(stdout, /REAL TARGETS OK/);
});
