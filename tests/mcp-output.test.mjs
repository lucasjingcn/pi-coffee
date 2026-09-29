import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {buildServer, summaryMeta, summaryReport} from '../dist/mcp-server.js';

test('routine status omits bulky contracts and proof while retaining actionable questions', () => {
  const meta={id:'s1',name:'task',status:'working',spec:{purpose:'implementation',scope:['a'],goal:'do work'},
    cost:0.2,turns:42,pendingQuestions:[{id:'q1',method:'confirm',title:'Choose',message:'Need answer',options:[]}],
    verification:{passed:true,result:{stdout:'many lines'}},integration:{mergedSha:'abc'},lastText:'long transcript'};
  const summary=summaryMeta(meta);
  assert.equal(summary.id,'s1');
  assert.equal(summary.pendingQuestions[0].id,'q1');
  assert.equal(summary.verified,true);
  assert.equal(summary.integrated,true);
  assert.equal(JSON.stringify(summary).includes('many lines'),false);
  assert.equal(JSON.stringify(summary).includes('long transcript'),false);
  assert.equal(JSON.stringify(summary).includes('scope'),false);
});

test('routine report retains cost coverage without embedding session snapshots', () => {
  const report={counts:{success_first:1},tasks:[{id:'s1',outcome:'success_first'}],cost_evidence:{
    selected_session_ids:['s1'],sessions:[{id:'s1',lastText:'long transcript'}],
    worker:{currency:'USD',total:0.2,complete:true,missing_session_ids:[]},
    orchestrator:{currency:null,total:null,complete:false,missing_session_ids:['s1'],records:[{text:'raw'}]},
    combined:{currency:null,total:null,complete:false,reasons:['Missing orchestrator cost']},
    activity:{tokens:{output:{known_subtotal:10}}},
  }};
  const summary=summaryReport(report);
  assert.equal(summary.cost_evidence.worker.total,0.2);
  assert.deepEqual(summary.cost_evidence.orchestrator.missing_session_ids,['s1']);
  assert.deepEqual(summary.cost_evidence.combined.reasons,['Missing orchestrator cost']);
  assert.equal(JSON.stringify(summary).includes('long transcript'),false);
  assert.equal(JSON.stringify(summary).includes('raw'),false);
  assert.deepEqual(summaryReport(report,'full'),report);
});

test('MCP status and report use concise defaults and permit explicit full detail', async () => {
  const meta={id:'s1',name:'task',status:'idle',pendingQuestions:[],
    spec:{goal:'do work',scope:['private-path'],purpose:'implementation'},lastText:'private transcript'};
  const report={counts:{unrecorded:1},tasks:[{id:'s1'}],cost_evidence:{
    sessions:[{id:'s1',lastText:'private transcript'}],
    worker:{currency:'USD',total:0.2,complete:true,missing_session_ids:[]},
    orchestrator:{currency:null,total:null,complete:false,missing_session_ids:['s1']},
    combined:{currency:null,total:null,complete:false,reasons:['Missing orchestrator cost']},
  }};
  let reportedIds;
  const server=buildServer({list:()=>[meta],snapshot:()=>meta,report:async(ids)=>{reportedIds=ids;return report;},metrics:async()=>({sessions:[meta]})});
  const client=new Client({name:'test-client',version:'1.0.0'});
  const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
    const call=async(name,args={})=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
    const status=await call('pi_status');
    assert.equal(status.sessions[0].id,'s1');
    assert.equal(JSON.stringify(status).includes('private-path'),false);
    assert.equal((await call('pi_status',{session_id:'s1',detail:'full'})).spec.scope[0],'private-path');
    assert.equal(JSON.stringify(await call('pi_report')).includes('private transcript'),false);
    await call('pi_report',{session_ids:['s1']});
    assert.deepEqual(reportedIds,['s1']);
    assert.deepEqual((await call('pi_list',{session_ids:['s1']})).sessions.map((item)=>item.id),['s1']);
    assert.equal((await call('pi_report',{detail:'full'})).cost_evidence.sessions[0].id,'s1');
  } finally {
    await client.close();
    await server.close();
  }
});
