import test from 'node:test';
import assert from 'node:assert/strict';
import {Mailbox} from '../dist/mailbox.js';
test('broadcast acknowledgements are recipient-specific',()=>{
 const box=new Mailbox();const msg=box.post('sender','*','hello','broadcast');
 box.markRead([msg.id],'one');assert.equal(box.inbox('one',{unreadOnly:true}).length,0);
 assert.equal(box.inbox('two',{unreadOnly:true}).length,1);assert.equal(box.inbox('one')[0].read,true);assert.equal(box.inbox('two')[0].read,false);
});
test('markAllRead consumes only one recipient broadcast state',()=>{
 const box=new Mailbox();box.post('sender','*','hello');box.post('sender','one','direct');
 box.markAllRead('one');assert.equal(box.inbox('one',{unreadOnly:true}).length,0);assert.equal(box.inbox('two',{unreadOnly:true}).length,1);
});
test('recipient ack cannot consume another recipient direct message',()=>{
 const box=new Mailbox();const msg=box.post('sender','two','private');box.markRead([msg.id],'one');
 assert.equal(box.inbox('two',{unreadOnly:true}).length,1);box.markRead([msg.id],'two');assert.equal(box.inbox('two',{unreadOnly:true}).length,0);
});
test('recipient broadcast acknowledgement survives export/import',()=>{
 const box=new Mailbox();const msg=box.post('sender','*','hello');box.markRead([msg.id],'one');
 const restored=new Mailbox();restored.import(JSON.parse(JSON.stringify(box.export())));
 assert.equal(restored.inbox('one',{unreadOnly:true}).length,0);assert.equal(restored.inbox('two',{unreadOnly:true}).length,1);
});
test('legacy global acknowledgement remains compatible',()=>{
 const box=new Mailbox();const msg=box.post('sender','*','hello');box.markRead([msg.id]);
 assert.equal(box.inbox('one',{unreadOnly:true}).length,0);assert.equal(box.inbox('two',{unreadOnly:true}).length,0);
});
