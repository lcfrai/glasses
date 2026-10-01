import {createHash} from 'node:crypto';
import {registryComponentIdentity,registryIndexItemURL} from './classification-policy.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
function publicEndpoint(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.href===value?value:null;}catch{return null;}}
function document(value){
 if(!value||typeof value.body!=='string'||Buffer.byteLength(value.body)>16*1024*1024||value.status!==200||!publicEndpoint(value.url)||hash(value.body)!==value.sha256||value.id!==hash(`${value.url}\n${value.sha256}`).slice(0,20)||!Number.isFinite(Date.parse(value.lastFetchedAt||value.firstFetchedAt)))return null;
 try{return {...value,data:JSON.parse(value.body)};}catch{return null;}
}
function inventory(files){
 if(!Array.isArray(files)||!files.length||files.length>1000)return null;
 const rows=[];
 for(const file of files){if(typeof file?.path!=='string'||!file.path||file.path.length>500||file.path.split(/[\\/]/).some(part=>!part||part==='..'||part==='.')||typeof file.type!=='string')return null;rows.push(JSON.stringify([file.path,file.type,file.target||null]));}
 if(new Set(rows).size!==rows.length)return null;
 return rows.sort().join('\n');
}
// Observed source identity, never provider-wide framework inheritance. The
// directory binds the GitHub namespace to its official index; that exact index
// binds one item and its file inventory to the fetched registry JSON.
export function officialRegistryFrameworkProof({itemUrl,index,directory,registry,source}){
 const identity=registryComponentIdentity(itemUrl);if(!identity)return null;
 const docs=[index,directory,registry,source].map(document);if(docs.some(value=>!value))return null;
 [index,directory,registry,source]=docs;
 if(index.url!=='https://registry.directory/items.json'||directory.url!=='https://registry.directory/directory.json'||!Array.isArray(index.data?.items)||!Array.isArray(directory.data?.registries)||!Array.isArray(registry.data?.items))return null;
 const indexed=index.data.items.filter(row=>registryIndexItemURL(row)===itemUrl);if(indexed.length!==1)return null;
 const repository=('https://github.com'+identity.basePath).toLowerCase();
 const providers=directory.data.registries.filter(row=>typeof row?.github_url==='string'&&row.github_url.replace(/\/$/,'').toLowerCase()===repository);if(providers.length!==1||providers[0].registry_url!==registry.url)return null;
 const entries=registry.data.items.filter(row=>row?.name===identity.name);if(entries.length!==1)return null;
 const entry=entries[0],data=source.data;
 if(entry.url!==undefined&&entry.url!==null&&!publicEndpoint(entry.url))return null;
 const explicit=publicEndpoint(entry.url),conventional=/\/registry\.json$/.test(registry.url)?registry.url.replace(/registry\.json$/,`${encodeURIComponent(identity.name)}.json`):null;
 if(source.url!==(explicit||conventional)||new URL(source.url).origin!==new URL(registry.url).origin||data?.name!==identity.name||data.type!==entry.type||typeof data.type!=='string')return null;
 const files=inventory(entry.files);if(!files||inventory(data.files)!==files||data.files.some(file=>typeof file.content!=='string'||file.content.length>150000))return null;
 return {indexed:indexed[0],entry,data,directory,registry,source};
}
