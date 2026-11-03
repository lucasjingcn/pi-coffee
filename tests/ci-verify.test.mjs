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
 assert.match(workflow,/typecheck:extensions/);
 assert.match(workflow,/config-validation/);
 const release=await readFile('.github/workflows/release.yml','utf8');
 assert.match(release,/Verify the tag matches the package version/);
 // A release that exists but has no image cannot be repaired by re-running:
 // gh release create fails on the duplicate and the image step is never reached.
 const imageStep=release.indexOf('Build and push container image');
 const releaseStep=release.indexOf('Create GitHub release');
 assert.ok(imageStep>=0&&releaseStep>=0,'both steps are present');
 assert.ok(imageStep<releaseStep,'the image is built before the release is created');
 assert.match(release,/release view/);assert.match(release,/--clobber/);
 assert.match(release,/--prerelease --latest=false/);
 assert.match(release,/== \*-\*/,'a pre-release tag does not move :latest');
 // And the image build is exercised by CI, not only by the release workflow.
 assert.match(workflow,/docker build --target runtime/);
 assert.match(workflow,/os:\s*- ubuntu-latest\s*- macos-latest/);
});
