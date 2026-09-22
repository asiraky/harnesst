import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validatePlan, nextTickets, assertIssueReady } from '../ticket-plan.mjs';
const head = 'a'.repeat(40), integrated = 'b'.repeat(40);
function plan() { return {version:1,issueId:'issue-1',specRevision:'spec-1',tickets:[
  {id:'01',title:'First behaviour',blockedBy:[],acceptanceCriteria:['User can create a draft'],status:'pending'},
  {id:'02',title:'Second behaviour',blockedBy:['01'],acceptanceCriteria:['User can publish the draft'],status:'pending'},
]}; }
function verify(ticket, sha = head) {
  Object.assign(ticket, {status:'verified',headSha:sha,checks:[{command:'npm test',result:'passed'}],review:{headSha:sha,specRevision:'spec-1',standards:'passed',spec:'passed',defects:'passed'},evidenceUrl:'https://example.test/review'});
}
test('only verified prerequisites release the next ticket', () => {
  const p = plan();
  assert.deepEqual(nextTickets(p).map(t=>t.id), ['01']);
  verify(p.tickets[0]);
  assert.deepEqual(nextTickets(p).map(t=>t.id), ['02']);
  verify(p.tickets[1]);
  assert.deepEqual(nextTickets(p), []);
});
test('rejects cycles, missing prerequisites, self-dependency and duplicate IDs', () => {
  for (const mutate of [p=>p.tickets[0].blockedBy.push('02'),p=>p.tickets[0].blockedBy.push('missing'),p=>p.tickets[0].blockedBy.push('01'),p=>p.tickets[1].id='01']) {
    const p=plan(); mutate(p); assert.throws(()=>validatePlan(p), /cycle|Unknown|unique/);
  }
});
test('cannot mark downstream ticket verified while its prerequisite is pending', () => {
  const p=plan(); verify(p.tickets[1]); assert.throws(()=>validatePlan(p), /prerequisite is not verified/);
});
test('stale review, changed specification and failed checks invalidate completion', () => {
  for (const mutate of [p=>p.tickets[0].review.headSha=integrated,p=>p.specRevision='spec-2',p=>p.tickets[0].checks[0].result='failed',p=>p.tickets[0].review.defects='failed']) {
    const p=plan(); verify(p.tickets[0]); mutate(p); assert.throws(()=>validatePlan(p), /review|checks/);
  }
});
test('one completed ticket cannot make the whole issue ready', () => {
  const p=plan(); verify(p.tickets[0]); assert.throws(()=>assertIssueReady(p,integrated,()=>true), /02: not verified/);
});
test('all ticket evidence must be included in the actual integration revision', () => {
  const p=plan(); p.tickets.forEach(t=>verify(t));
  assert.throws(()=>assertIssueReady(p,integrated,()=>false), /not in the integrated revision/);
  const seen=[];
  assert.deepEqual(assertIssueReady(p,integrated,(a,b)=>{seen.push([a,b]);return true}),{issueId:'issue-1',headSha:integrated,tickets:2});
  assert.equal(seen.length,2);
});
test('CLI checks real Git ancestry and rejects an unrelated verified commit', () => {
  const dir=mkdtempSync(join(tmpdir(),'issue-ticket-'));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const cli=resolve('catalog/ledger/ticket-plan.mjs');
  try {
    git('init'); git('config','user.name','Test'); git('config','user.email','test@example.test');
    writeFileSync(join(dir,'product.txt'),'first'); git('add','.'); git('commit','-m','ticket one'); const first=git('rev-parse','HEAD');
    writeFileSync(join(dir,'product.txt'),'second'); git('add','.'); git('commit','-m','ticket two'); const second=git('rev-parse','HEAD');
    const p=plan(); verify(p.tickets[0],first); verify(p.tickets[1],second);
    writeFileSync(join(dir,'tickets.json'),JSON.stringify(p));
    const result=JSON.parse(execFileSync(process.execPath,[cli,'ready','tickets.json',second],{cwd:dir,encoding:'utf8'}));
    assert.equal(result.tickets,2);
    git('checkout','--orphan','other'); git('commit','--allow-empty','-m','unrelated'); const other=git('rev-parse','HEAD');
    assert.throws(()=>execFileSync(process.execPath,[cli,'ready','tickets.json',other],{cwd:dir,stdio:'pipe'}), /not in the integrated revision/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
