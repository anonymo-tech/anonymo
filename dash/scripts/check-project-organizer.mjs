import assert from 'node:assert/strict';
import test from 'node:test';
import {isProjectView, sortProjects} from '../lib/project-organizer.ts';
test('project sort supports names, recency and stable ties without mutating source',()=>{
 const source=[{id:'b',name:'Zebra',updatedAt:2},{id:'a',name:'Alpha',updatedAt:2},{id:'c',name:'Beta',updatedAt:1}];
 assert.deepEqual(sortProjects(source,'name').map(x=>x.id),['a','c','b']);
 assert.deepEqual(sortProjects(source,'recent').map(x=>x.id),['a','b','c']);
 assert.deepEqual(sortProjects(source,'oldest').map(x=>x.id),['c','a','b']);
 assert.equal(source[0].id,'b');
 assert.equal(isProjectView({layout:'list',sort:'name'}),true);
 for(const value of [null,[],{layout:'table',sort:'name'},{layout:'cards',sort:'random'}])assert.equal(isProjectView(value),false);
});
import {isProjectLabels,setProjectLabel} from '../lib/project-organizer.ts';
test('project labels accept only bounded IDs and known labels; removal preserves other projects',()=>{
 const labels=setProjectLabel({},'project-a','work');
 const withSecond=setProjectLabel(labels,'project-b','research');
 assert.deepEqual(setProjectLabel(withSecond,'project-a',''),{'project-b':'research'});
 assert.deepEqual(labels,{'project-a':'work'});
 for(const value of [null,[],{'project-a':'invented'},{'<script>':'work'}])assert.equal(isProjectLabels(value),false);
 assert.throws(()=>setProjectLabel({},'../project','work'));
 assert.throws(()=>setProjectLabel({},'project','invented'));
});
