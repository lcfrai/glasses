import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicCatalogue, validatePublicCatalogue, mergePublicCatalogues, publicCatalogueJsonSchema, publicCatalogueEvidenceIds } from '../src/public-catalogue.mjs';
import { createStore } from '../src/store.mjs';
import { readPublicCatalogueFile } from '../src/public-catalogue-file.mjs';

function storedJSON(row){try{return JSON.parse(row.data);}catch{throw new Error('Invalid stored catalogue JSON');}}
export function admitPublicGithubCandidates(inputs,urls) {
  if(!Array.isArray(urls)||urls.length>100000||urls.some(url=>typeof url!=='string'||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url)))throw new Error('GitHub admission file requires bounded canonical repository URLs');
  const admitted=new Set(urls.map(url=>url.replace(/\/$/,'').toLowerCase()));
  const capabilities=inputs.capabilities.filter(item=>!/^https:\/\/github\.com\//i.test(item.url)||admitted.has(item.url.replace(/\/$/,'').toLowerCase()));
  return {inputs:{...inputs,capabilities},omitted:inputs.capabilities.length-capabilities.length};
}

export function readPublicCatalogueInputs(dataDir,{ids}={}) {
  if(ids!==undefined&&(!Array.isArray(ids)||ids.length>100000||ids.some(id=>typeof id!=='string')))throw new Error('Invalid projection membership');
  const db=new DatabaseSync(join(resolve(dataDir),'glasses.sqlite'),{readOnly:true});
  let capabilities,evidence;
  // Runtime source bodies are already retained in evidence. Do not duplicate
  // them in the projection input, or trust editable preview files as proof.
  const selection="SELECT json_remove(data,'$.repositoryFiles','$.sourceFiles','$.previewFiles','$.previewSource','$.previewCss','$.previewProps') AS data FROM capabilities";
  try{db.exec('BEGIN');const rows=ids?(()=>{const get=db.prepare(selection+' WHERE id=?');return [...new Set(ids)].map(id=>get.get(id)).filter(Boolean);})():db.prepare(selection).all();capabilities=rows.map(storedJSON);const get=db.prepare('SELECT data FROM evidence WHERE id=?');evidence=publicCatalogueEvidenceIds(capabilities).map(id=>get.get(id)).filter(Boolean).map(storedJSON);db.exec('COMMIT');}finally{db.close();}
  let assessments=[];
  try{const intelligence=new DatabaseSync(join(resolve(dataDir),'intelligence.sqlite'),{readOnly:true});try{const get=intelligence.prepare('SELECT data FROM assessments WHERE id=?');assessments=capabilities.filter(item=>item.origin==='live').map(item=>get.get(item.id)).filter(Boolean).map(storedJSON);}finally{intelligence.close();}}
  catch(error){if(error.code!=='ERR_SQLITE_ERROR'||!/unable to open database file/.test(error.message))throw error;}
  return {capabilities,evidence,assessments};
}
async function save(path,value){const file=resolve(path);await mkdir(dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx'});await rename(temporary,file);}
async function main(){
  const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){if(!['--data-dir','--out','--schema-out','--validate','--merge','--input','--import','--github-allowlist'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Usage: --data-dir DIR --out FILE [--schema-out FILE] [--github-allowlist FILE], --validate FILE, --import FILE --data-dir DIR, or --merge CURRENT --input INCOMING --out FILE');options[args[i].slice(2)]=args[i+1];}
  if(options.validate){const snapshot=await readPublicCatalogueFile(options.validate);console.log(JSON.stringify({valid:true,contentHash:snapshot.contentHash,counts:snapshot.counts}));return;}
  if(options.import){if(!options['data-dir'])throw new Error('--data-dir is required for local import');const snapshot=await readPublicCatalogueFile(options.import),store=createStore(options['data-dir']);try{console.log(JSON.stringify({imported:true,report:await store.importPublicCatalogue(snapshot),counts:store.counts(),networkCalls:0,inferenceCalls:0,portableInferenceCache:false}));}finally{store.close();}return;}
  if(!options.out)throw new Error('--out is required; this command never publishes');
  let result;
  if(options.merge){if(!options.input)throw new Error('--input is required for merge');result=mergePublicCatalogues(await readPublicCatalogueFile(options.merge),await readPublicCatalogueFile(options.input));}
  else {if(!options['data-dir'])throw new Error('--data-dir is required');let inputs=readPublicCatalogueInputs(options['data-dir']),omitted=0;if(options['github-allowlist']){const selected=admitPublicGithubCandidates(inputs,storedJSON({data:await readFile(options['github-allowlist'],'utf8')}).urls);inputs=selected.inputs;omitted=selected.omitted;}result=createPublicCatalogue(inputs);result.report.githubNotAdmitted=omitted;}
  await save(options.out,result.snapshot);if(options['schema-out'])await save(options['schema-out'],publicCatalogueJsonSchema);
  console.log(JSON.stringify({counts:result.snapshot.counts,contentHash:result.snapshot.contentHash,report:result.report,portableInferenceCache:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
