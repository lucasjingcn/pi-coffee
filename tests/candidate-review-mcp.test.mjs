import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {buildServer} from '../dist/mcp-server.js';

test('pi_review requires the worker capability and forwards exact candidate and structured evidence',async()=>{
  const calls=[];
  const server=buildServer({assertControl:(id,key)=>{if(id!=='s1'||key!=='owner')throw new Error('invalid control_key');},
    review:async(id,verificationId,input)=>{calls.push({id,verificationId,input});return {verificationId,...input};}});
  const client=new Client({name:'review-mcp-test',version:'1'});const [s,c]=InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(s),client.connect(c)]);
    const args={session_id:'s1',verification_id:'candidate-exact-id',requirements:[{id:'r1',met:true,evidence:'test passed and file reviewed'}],test_changes:[]};
    assert.equal((await client.callTool({name:'pi_review',arguments:args})).isError,true);
    assert.equal((await client.callTool({name:'pi_review',arguments:{...args,control_key:'other-chat'}})).isError,true);
    assert.equal(calls.length,0);
    assert.equal((await client.callTool({name:'pi_review',arguments:{...args,control_key:'owner'}})).isError,undefined);
    assert.deepEqual(calls,[{id:'s1',verificationId:'candidate-exact-id',input:{requirements:args.requirements,test_changes:[]}}]);
    const schema=(await client.listTools()).tools.find(t=>t.name==='pi_spawn').inputSchema.properties.spec.properties;
    assert.ok(schema.requirements);assert.ok(schema.validation_paths);
  } finally {await client.close();await server.close();}
});

test('duplicate requirement IDs are rejected by pi_spawn before it creates a worker',async()=>{
  let spawned=false;const server=buildServer({spawn:async()=>{spawned=true;},activeWorkers:()=>0,config:{parallelWarnThreshold:4}});
  const client=new Client({name:'spec-mcp-test',version:'1'});const [s,c]=InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(s),client.connect(c)]);
    const result=await client.callTool({name:'pi_spawn',arguments:{spec:{goal:'change',scope:['src'],requirements:[{id:'x',text:'one'},{id:'x',text:'two'}]}}});
    assert.equal(result.isError,true);assert.equal(spawned,false);
  } finally {await client.close();await server.close();}
});
