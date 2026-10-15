import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const record=JSON.parse(await readFile(path.join(root,'production-source.json'),'utf8'));
if(record.schemaVersion!==1||!Array.isArray(record.files)||record.files.length!==record.sourceFileCount)throw new Error('Invalid source record');
const seen=new Set(),mismatches=[];
for(const entry of record.files){
  if(typeof entry.path!=='string'||entry.path.includes('\\')||entry.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(entry.path)||!/^[0-9a-f]{64}$/.test(entry.sha256))throw new Error('Unsafe source entry');
  seen.add(entry.path);
  const file=path.resolve(root,entry.path);
  if(!file.startsWith(root+path.sep))throw new Error('Source path escaped repository');
  try{
    const st=await lstat(file);
    if(!st.isFile()||st.isSymbolicLink())throw new Error('Not a regular file');
    if(createHash('sha256').update(await readFile(file)).digest('hex')!==entry.sha256)mismatches.push(entry.path);
  }catch{mismatches.push(entry.path);}
}
if(mismatches.length){console.error('Files differ from the recorded production source:',mismatches);process.exitCode=1;}
else console.log(`Verified ${seen.size} files for deployment ${record.deployment}.`);
