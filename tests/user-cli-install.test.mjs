import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installCli} from '../scripts/install-cli.mjs';
import {writeEnvFile} from '../scripts/lib/env.mjs';
const version=JSON.parse(readFileSync('package.json','utf8')).devDependencies['@earendil-works/pi-coding-agent'];
function fixture(fn){
 const home=realpathSync(mkdtempSync(join(tmpdir(),"pi-user %h ' quote $ ")));
 try{
  const packageDir=join(home,'.local/share/pi-cli/node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(join(packageDir,'dist/bundle'),{recursive:true});
  writeFileSync(join(packageDir,'package.json'),JSON.stringify({version,type:'module'}));
  writeFileSync(join(packageDir,'dist/bundle/cli.js'),`if(process.argv.includes('--version'))console.log(${JSON.stringify(version)});else console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),key:process.env.PI_TEST_API_KEY}));`);
  fn(home);
 }finally{rmSync(home,{recursive:true,force:true});}
}
test('user pi runs outside checkout, preserves cwd/arguments and loads configured defaults',()=>fixture(home=>{
 writeFileSync(join(home,'.zshrc'),'# existing user config\n');
 const {entry,binDir}=installCli({home,platform:'linux',shell:'/bin/zsh'});
 const envFile=join(home,'env');
 writeEnvFile({PI_COFFEE_PROVIDER:'fixture-provider',PI_COFFEE_MODEL:'fixture-model',PI_COFFEE_THINKING:'xhigh',PI_TEST_API_KEY:'fixture-key'},envFile);
 const outside=join(home,'other project');mkdirSync(outside);
 const env={...process.env,PI_COFFEE_ENV_FILE:envFile};
 delete env.PI_COFFEE_PROVIDER;delete env.PI_COFFEE_MODEL;delete env.PI_COFFEE_THINKING;
 const run=args=>JSON.parse(execFileSync(entry,args,{cwd:outside,env,encoding:'utf8'}));
 const normal=run(['message with spaces',"quote's",'$literal']);
 assert.equal(normal.cwd,outside);assert.equal(normal.key,'fixture-key');
 assert.deepEqual(normal.args,['--provider','fixture-provider','--model','fixture-model','--thinking','xhigh','message with spaces',"quote's",'$literal']);
 assert.deepEqual(run(['--model','other/model:high','hello']).args,['--model','other/model:high','hello']);
 assert.deepEqual(run(['--provider','other','--thinking','off']).args,['--provider','other','--thinking','off']);
 const shell=execFileSync('/bin/sh',['-c','pi --version'],{cwd:outside,env:{...env,PATH:binDir+':'+env.PATH},encoding:'utf8'}).trim();
 assert.equal(shell,version);
 const first=readFileSync(join(home,'.zshrc'),'utf8');
 assert.ok(first.startsWith('# existing user config\n'));
 installCli({home,platform:'linux',shell:'/bin/zsh'});
 assert.equal(readFileSync(join(home,'.zshrc'),'utf8'),first,'PATH setup is idempotent');
 chmodSync(entry,0o644);
 installCli({home,platform:'linux',shell:'/bin/zsh'});
 assert.equal(execFileSync(entry,['--version'],{env,encoding:'utf8'}).trim(),version,'managed entry remains executable');
}));
test('installer refuses to overwrite an unrelated pi command',()=>fixture(home=>{
 const bin=join(home,'.local/bin');mkdirSync(bin,{recursive:true});const entry=join(bin,'pi');
 writeFileSync(entry,'#!/bin/sh\necho unrelated\n');
 assert.throws(()=>installCli({home,platform:'linux',shell:'/bin/zsh'}),/unmanaged/);
 assert.equal(readFileSync(entry,'utf8'),'#!/bin/sh\necho unrelated\n');
}));
test('Windows creates a quoted user command with percent escaping',()=>fixture(home=>{
 const {entry}=installCli({home,platform:'win32',nodePath:process.execPath,configurePath:false});
 const cmd=readFileSync(entry,'utf8');
 assert.ok(entry.endsWith('pi.cmd'));assert.match(cmd,/@echo off/);assert.ok(cmd.includes('"'+process.execPath+'"'));assert.match(cmd,/%\*/);assert.ok(cmd.includes(home.replace(/%/g,'%%')));
}));
test('all installation entry points include user CLI setup',()=>{
 assert.match(readFileSync('install.sh','utf8'),/npm run install:cli/);
 assert.match(readFileSync('deploy/windows/install.ps1','utf8'),/\$npm run install:cli/);
});

test('fresh installation requests the repository pinned pi package in the independent prefix',()=>fixture(home=>{
 const packageDir=join(home,'.local/share/pi-cli/node_modules/@earendil-works/pi-coding-agent');
 const source=readFileSync(join(packageDir,'dist/bundle/cli.js'),'utf8');
 rmSync(packageDir,{recursive:true,force:true});
 const npmCli=join(home,'fake-npm.mjs');
 const log=join(home,'npm-args.json');
 writeFileSync(npmCli,`import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const args=process.argv.slice(2);writeFileSync(${JSON.stringify(log)},JSON.stringify(args));const prefix=args[args.indexOf('--prefix')+1];const dir=join(prefix,'node_modules/@earendil-works/pi-coding-agent');mkdirSync(join(dir,'dist/bundle'),{recursive:true});writeFileSync(join(dir,'package.json'),JSON.stringify({version:${JSON.stringify(version)},type:'module'}));writeFileSync(join(dir,'dist/bundle/cli.js'),${JSON.stringify(source)});`);
 const result=installCli({home,platform:'linux',npmCli});
 const args=JSON.parse(readFileSync(log,'utf8'));
 assert.equal(args[args.indexOf('--prefix')+1],join(home,'.local/share/pi-cli'));
 assert.equal(args.at(-1),'@earendil-works/pi-coding-agent@'+version);
 assert.ok(args.includes('--ignore-scripts'));
 assert.equal(result.version,version);
}));

test('PATH setup touches only the selected shell startup files',()=>fixture(home=>{
 writeFileSync(join(home,'.bash_profile'),'# unrelated bash profile\n');
 installCli({home,platform:'linux',shell:'/bin/zsh'});
 assert.equal(readFileSync(join(home,'.bash_profile'),'utf8'),'# unrelated bash profile\n');
 assert.match(readFileSync(join(home,'.zprofile'),'utf8'),/\.local\/bin/);
 installCli({home,platform:'linux',shell:'/bin/bash'});
 assert.match(readFileSync(join(home,'.bash_profile'),'utf8'),/\.local\/bin/);
 assert.match(readFileSync(join(home,'.bashrc'),'utf8'),/\.local\/bin/);
}));
