import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('portable verify command and CI cover extension and offline suite',async()=>{
 const pkg=JSON.parse(await readFile('package.json','utf8'));
 assert.ok(pkg.scripts.verify);assert.ok(pkg.scripts['typecheck:extensions']);
 assert.ok(pkg.devDependencies['@earendil-works/pi-coding-agent']);
 const ext=await readFile('tsconfig.ext.json','utf8');assert.doesNotMatch(ext,/\/root\/|\/home\//);
 const workflow=await readFile('.github/workflows/verify.yml','utf8');
 assert.match(workflow,/pull_request/);assert.match(workflow,/push/);assert.match(workflow,/npm ci/);assert.match(workflow,/npm run verify/);
 assert.match(workflow,/22\.19/);assert.match(workflow,/24/);
 assert.match(workflow,/runs-on: \$\{\{ matrix\.os \}\}/);
 assert.match(workflow,/os:\s*- ubuntu-latest\s*- macos-latest/);
});
