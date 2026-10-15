import type {Pool} from 'pg';
import {featureOn} from '../../components/dashboard/feature-switches.ts';
import {jsonResponse,readJson,stringField} from '../core/http.ts';
import {requireCondition} from '../core/errors.ts';
import {readCursor,nextCursor} from '../core/pagination.ts';
import {digestText} from '../core/digest.ts';
import {readComparison} from './comparisons.ts';
import {findExcerpt,type RecallHit} from '../../lib/recall.ts';
export async function recallRoutes(pool:Pool,request:Request,path:string,accountId:string):Promise<Response|null>{
 if(path!=='history/search'||request.method!=='POST')return null;
 requireCondition(featureOn('recall'),404,'FEATURE_UNAVAILABLE','This feature is not available.');
 const body=await readJson(request,2048),query=stringField(body,'query',120).trim();
 requireCondition(query.length>=2,400,'QUERY_TOO_SHORT','Enter at least two characters.');
 const scope=`${accountId}:recall:${await digestText('recall-query',query)}`;
 requireCondition(body.cursor===undefined||body.cursor===null||typeof body.cursor==='string',400,'INVALID_CURSOR','The search cursor is invalid.');
 const cursor=readCursor(body.cursor as string|null,scope);
 const rows=await pool.query<{id:string;project_title:string;cursorTime:string}>(`SELECT c.id,p.title AS project_title,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime" FROM comparisons c JOIN projects p ON p.id=c.project_id AND p.account_id=c.account_id WHERE c.account_id=$1 AND p.archived_at IS NULL AND ($2::timestamptz IS NULL OR (c.created_at,c.id)<($2::timestamptz,$3::uuid)) ORDER BY c.created_at DESC,c.id DESC LIMIT 11`,[accountId,cursor?.time??null,cursor?.id??null]);
 const hits:RecallHit[]=[];
 for(const row of rows.rows.slice(0,10)){
  const comparison=await readComparison(pool,accountId,row.id);
  const excerpt=findExcerpt(comparison.prompt,query)??comparison.calls.map(call=>findExcerpt(call.output,query)).find(Boolean);
  if(excerpt)hits.push({projectId:comparison.projectId,projectTitle:row.project_title,comparisonId:comparison.id,prompt:comparison.prompt.slice(0,180),excerpt});
 }
 return jsonResponse({hits,scanned:Math.min(rows.rows.length,10),nextCursor:nextCursor(rows.rows,10,scope)});
}
