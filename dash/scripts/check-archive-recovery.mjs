import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {createDatabase} from '../server/db/database.ts';
import {generateSessionToken,hashToken,SESSION_COOKIE_NAME} from '../server/auth/index.ts';
import {dispatch} from '../server/routes/dispatch.ts';
import {FEATURE_SWITCHES} from '../components/dashboard/feature-switches.ts';
import {createWorkspaceClient} from '../lib/client/workspace.ts';
const connection=process.env.CONCLAVE_TEST_DATABASE_URL;
const local=new URL(connection);
assert.equal(local.hostname,'127.0.0.1');assert.match(local.pathname,/_test$/);
Object.assign(process.env,{CONCLAVE_MODE:'service',CONCLAVE_APP_ORIGIN:'https://conclave.test',CONCLAVE_DATABASE_URL:connection,CONCLAVE_DATA_KEYS:JSON.stringify({test:randomBytes(32).toString('base64')}),CONCLAVE_ACTIVE_DATA_KEY:'test'});
const pool=createDatabase(connection,4);after(()=>pool.end());
async function person(){const id=randomUUID(),token=generateSessionToken();await pool.query('INSERT INTO accounts(id) VALUES($1)',[id]);await pool.query("INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[await hashToken(token),id]);return{id,token};}
async function call(who,path,body,method=body===undefined?'GET':'POST'){
 const response=await dispatch(new Request(`https://conclave.test/api/${path}`,{method,headers:{origin:'https://conclave.test','content-type':'application/json',...(who?{cookie:`${SESSION_COOKIE_NAME}=${who.token}`,'x-conclave-account-id':who.id}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return{status:response.status,body:await response.json()};
}
test('archive restore is authenticated, account-bound, revision-safe and preserves project records',async()=>{
 const owner=await person(),other=await person();
 const created=await call(owner,'projects',{title:'Restore this project'});assert.equal(created.status,201);const id=created.body.project.id;
 assert.equal((await call(owner,`projects/${id}`,{revision:1},'DELETE')).status,200);
 assert.equal((await call(null,'projects/archived')).status,401);
 assert.equal((await call(other,'projects/archived')).body.projects.length,0);
 assert.equal((await call(other,`projects/${id}/restore`,{revision:2})).status,404);
 assert.equal((await call(owner,`projects/${id}/restore`,{revision:1})).status,409);
 assert.equal((await call(owner,`projects/${id}/restore`,{revision:'2'})).status,400);
 const listing=await call(owner,'projects/archived');assert.equal(listing.body.projects[0].id,id);assert.equal(listing.body.projects[0].revision,2);
 assert.equal((await call(owner,'projects')).body.projects.length,0);
 const results=await Promise.all([call(owner,`projects/${id}/restore`,{revision:2}),call(owner,`projects/${id}/restore`,{revision:2})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const restored=results.find(r=>r.status===200).body.project;assert.equal(restored.title,'Restore this project');assert.equal(restored.revision,3);
 assert.equal((await call(owner,'projects/archived')).body.projects.length,0);
 assert.equal((await call(owner,'projects')).body.projects[0].id,id);
 assert.equal((await pool.query('SELECT archived_at,revision FROM projects WHERE id=$1',[id])).rows[0].archived_at,null);
});
test('archive pagination is bounded and account-scoped; held gate blocks both endpoints',async()=>{
 const owner=await person(),other=await person();
 for(let i=0;i<51;i++)await pool.query('INSERT INTO projects(id,account_id,title,archived_at) VALUES($1,$2,$3,now())',[randomUUID(),owner.id,`Archive ${i}`]);
 const first=await call(owner,'projects/archived');assert.equal(first.body.projects.length,50);assert.ok(first.body.nextCursor);
 const second=await call(owner,`projects/archived?cursor=${first.body.nextCursor}`);assert.equal(second.body.projects.length,1);
 assert.equal((await call(other,`projects/archived?cursor=${first.body.nextCursor}`)).status,400);
 const enabled=FEATURE_SWITCHES.archiveRecovery;FEATURE_SWITCHES.archiveRecovery=false;
 try{assert.equal((await call(owner,'projects/archived')).status,404);assert.equal((await call(owner,`projects/${first.body.projects[0].id}/restore`,{revision:1})).status,404);}finally{FEATURE_SWITCHES.archiveRecovery=enabled;}
});
test('archive client uses protected same-origin endpoints and exact revision',async()=>{
 const account=randomUUID(),project={id:randomUUID(),title:'Restored',revision:3};const requests=[];
 const client=createWorkspaceClient({accountId:account,fetch:async(path,options)=>{requests.push({path,options});return Response.json(path.includes('/restore')?{project}:{projects:[project],nextCursor:null});}});
 assert.equal((await client.archivedProjects()).items[0].id,project.id);
 assert.equal((await client.restoreProject(project.id,2)).revision,3);
 assert.equal(new URL(requests[0].path,'https://conclave.test').pathname,'/api/projects/archived');assert.equal(requests[1].options.headers['X-Conclave-Account-Id'],account);assert.deepEqual(JSON.parse(requests[1].options.body),{revision:2});assert.equal(requests[1].options.credentials,'same-origin');assert.equal(requests[1].options.redirect,'error');
});
