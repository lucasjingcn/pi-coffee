import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
async function bridge(handler,wire){
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const child=spawn(process.execPath,['dist/stdio-proxy.js'],{env:{...process.env,PI_COFFEE_URL:'http://127.0.0.1:'+server.address().port+'/mcp',PI_COFFEE_TOKEN:''},stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code)=>code===0?resolve():reject(new Error(err)));});
 child.stdin.end(wire);
 try{await done;return out.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));}finally{child.kill('SIGKILL');await new Promise(r=>server.close(r));}
}
const msg=JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'pi_spawn',arguments:{}}});
test('HTTP failure never retries a possibly executed mutation',{timeout:5000},async()=>{
 let calls=0;const records=await bridge((req,res)=>{calls++;req.resume();res.writeHead(calls===1?500:200,{'content-type':'application/json'});res.end(calls===1?'failure':JSON.stringify({jsonrpc:'2.0',id:7,result:{ok:true}}));},msg+'\n');
 assert.equal(calls,1);assert.equal(records[0].id,7);assert.ok(records[0].error);
});
test('empty or invalid daemon response returns a correlated error',{timeout:5000},async()=>{
 for(const body of ['', 'invalid-json']){
 const records=await bridge((req,res)=>{req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(body);},msg+'\n');
 assert.equal(records.length,1);assert.equal(records[0].id,7);assert.ok(records[0].error);
 }
});
test('last stdin request without newline is processed on EOF',{timeout:5000},async()=>{
 let calls=0;const records=await bridge((req,res)=>{calls++;req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:7,result:{ok:true}}));},msg);
 assert.equal(calls,1);assert.equal(records[0].result.ok,true);
});
