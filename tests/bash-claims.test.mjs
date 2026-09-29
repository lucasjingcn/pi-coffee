import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const cases=[
  {
    "title": "quoted JavaScript arrow returning new",
    "cmd": "node -e 'const task = () => new Promise(resolve => setTimeout(resolve, 5)); task();'",
    "paths": []
  },
  {
    "title": "quoted JavaScript arrow calling setTimeout",
    "cmd": "node -e \"const task = resolve => setTimeout(resolve, 5);\"",
    "paths": []
  },
  {
    "title": "JavaScript heredoc",
    "cmd": "node <<'JS'\nconst task = () => new Promise(resolve => setTimeout(resolve, 5));\nconsole.log(\"tee fake.txt > ghost.txt\");\nJS\n",
    "paths": []
  },
  {
    "title": "comments and quoted examples",
    "cmd": "printf '%s\\n' 'tee fake.txt > ghost.txt'; # echo > comment.txt",
    "paths": []
  },
  {
    "title": "sed replacement contains slash and filename-like text",
    "cmd": "sed -i 's/old/new/g; s/a/setTimeout.js/g' src/app.ts",
    "paths": [
      "src/app.ts"
    ]
  },
  {
    "title": "tee actual outputs",
    "cmd": "printf hello | tee -a \"out one.txt\" out-two.txt",
    "paths": [
      "out one.txt",
      "out-two.txt"
    ]
  },
  {
    "title": "redirect stdout and stderr",
    "cmd": "node -e 'const f = () => new Date()' > \"result file.txt\" 2> errors.log",
    "paths": [
      "result file.txt",
      "errors.log"
    ]
  },
  {
    "title": "append and fd duplication",
    "cmd": "printf hello >> log.txt 2>&1",
    "paths": [
      "log.txt"
    ]
  },
  {
    "title": "sed explicit scripts and -- operands",
    "cmd": "sed -i -e 's/old/new/g' -e 's/a/b/g' -- \"src/a file.ts\" src/b.ts",
    "paths": [
      "src/a file.ts",
      "src/b.ts"
    ]
  },
  {
    "title": "sed file script is an input",
    "cmd": "sed -i.bak -f edits.sed src/app.ts",
    "paths": [
      "src/app.ts"
    ]
  },
  {
    "title": "macOS sed backup option",
    "cmd": "sed -i '' 's/old/new/g' src/app.ts",
    "paths": [
      "src/app.ts"
    ]
  },
  {
    "title": "heredoc followed by actual output",
    "cmd": "node <<'JS' > result.txt\nconst f=()=>new Promise(r=>setTimeout(r,1));\nJS\nprintf ok >> final.txt",
    "paths": [
      "result.txt",
      "final.txt"
    ]
  },
  {
    "title": "normal edit dotdot-prefixed file",
    "tool": "write",
    "path": "..notes.txt",
    "paths": [
      "..notes.txt"
    ]
  },
  {
    "title": "normal outside edit blocked",
    "tool": "write",
    "path": "../outside.txt",
    "blocked": true,
    "paths": []
  }
];
test('extension claims actual shell write operands without treating source code as paths',{timeout:15000},async()=>{
 const code=`
 import assert from 'node:assert/strict';
 process.env.PI_COORD_URL='http://coordinator.test';process.env.PI_COORD_SESSION_ID='one';
 const handlers=new Map();let claims=[];
 globalThis.fetch=async(url,opts)=>{
 const body=JSON.parse(opts.body||'{}');if(new URL(url).pathname==='/internal/authorize-write')return {ok:true,text:async()=>JSON.stringify({ok:true})};assert.equal(new URL(url).pathname,'/internal/claim');claims.push(...body.paths);
 return {ok:true,text:async()=>JSON.stringify({ok:true,granted:body.paths,conflicts:[]})};
 };
 const extension=(await import('./extensions/pi-coordinator.ts')).default;
 for(const c of ${JSON.stringify(cases)}){
 claims=[];handlers.clear();extension({registerTool(){},on(n,f){handlers.set(n,f);}});
 const tool=c.tool||'bash';const outcome=await handlers.get('tool_call')({toolName:tool,input:tool==='bash'?{command:c.cmd}:{path:c.path}},{cwd:'/worktree'});
 assert.equal(Boolean(outcome?.block), Boolean(c.blocked), c.title);
 assert.deepEqual([...new Set(claims)].sort(),[...new Set(c.paths)].sort(),c.title);
 }
 console.log('CLAIMS OK');
 `;
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),timeout:12000});
 assert.match(stdout,/CLAIMS OK/);
});
