import {createHash} from 'node:crypto';

export const MAX_RAW_README_BYTES=4*1024*1024;
const digest=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
const safePath=value=>typeof value==='string'&&value.length>0&&value.length<=500&&!/[\\\x00-\x1f?#%:]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..')&&/^readme(?:[._-][A-Za-z\d_.-]+)?$/i.test(value.split('/').at(-1));
const encoded=value=>value.split('/').map(encodeURIComponent).join('/');

export function rawReadmeIdentity(value){
  try{const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='raw.githubusercontent.com'||url.port||url.username||url.password||url.search||url.hash)return null;
    const match=url.pathname.match(/^\/([A-Za-z\d_.-]+)\/([A-Za-z\d_.-]+)\/([a-f\d]{40})\/(.+)$/);if(!match)return null;
    const repository=match[1]+'/'+match[2],path=decodeURIComponent(match[4]);if(!safePath(path)||url.href!==`https://raw.githubusercontent.com/${repository}/${match[3]}/${encoded(path)}`)return null;
    return{repository,revision:match[3],path,url:url.href};
  }catch{return null;}
}

export function base64ReadmeVerified(data){
  if(data?.encoding!=='base64'||typeof data.content!=='string'||!Number.isSafeInteger(data.size)||data.size<1||data.size>MAX_RAW_README_BYTES||!/^[a-f\d]{40}$/.test(data.sha||''))return false;
  const bytes=Buffer.from(data.content,'base64');
  return bytes.length===data.size&&digest(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]),'sha1')===data.sha&&Buffer.from(bytes.toString('utf8')).equals(bytes);
}

/** A pinned API declaration can recover omitted or truncated inline bytes. */
export function rawReadmeDeclaration(apiSource,{repository,revision}){
  if(typeof apiSource?.body!=='string'||apiSource.status!==200||digest(apiSource.body)!==(apiSource.sha256||apiSource.evidence?.sha256))throw new Error('README API evidence integrity mismatch');
  if(apiSource.url!==`https://api.github.com/repos/${repository}/readme?ref=${revision}`||!/^[a-f\d]{40}$/.test(revision))throw new Error('README API source is not the exact pinned repository');
  const data=JSON.parse(apiSource.body),raw=rawReadmeIdentity(data.download_url);
  const omitted=data.encoding==='none'||data.encoding==='base64'&&typeof data.content==='string'&&!base64ReadmeVerified(data);
  if(!omitted||!raw||raw.repository!==repository||raw.revision!==revision||raw.path!==data.path||!/^[a-f\d]{40}$/.test(data.sha||'')||!Number.isSafeInteger(data.size)||data.size<1||data.size>MAX_RAW_README_BYTES)throw new Error('Unsupported or unbounded pinned raw README declaration');
  return{...raw,bytes:data.size,gitBlobSha:data.sha};
}

// An intact pinned base64 body can prove an unsupported encoding without a
// second download. A corrupt/truncated body is never an encoding exception.
export function pinnedNonUtf8Readme(apiSource,identity,rawBytes){
  const data=JSON.parse(apiSource.body);
  if(!rawBytes&&(data?.encoding!=='base64'||typeof data.content!=='string'))return null;
  const declared=rawReadmeDeclaration(apiSource,identity),bytes=Buffer.from(rawBytes?.bodyBase64??data.content,'base64');
  if(rawBytes&&(rawBytes.url!==declared.url||rawBytes.status!==200||rawBytes.bodyBase64!==bytes.toString('base64')||rawBytes.sha256!==digest(bytes)))return null;
  if(bytes.length!==declared.bytes||digest(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]),'sha1')!==declared.gitBlobSha)return null;
  try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);return null;}catch{}
  return{kind:rawBytes?'verified-pinned-non-utf8-raw':'verified-pinned-non-utf8-base64',path:declared.path,bytes:bytes.length,gitBlobSha:declared.gitBlobSha,sha256:digest(bytes),losslessUtf8:false};
}

export function verifyRawReadme(rawSource,apiSource,identity){
  const declared=rawReadmeDeclaration(apiSource,identity),bytes=typeof rawSource?.body==='string'?Buffer.from(rawSource.body):null;
  if(rawSource?.url!==declared.url||rawSource.status!==200||!bytes||bytes.length!==declared.bytes||bytes.length>MAX_RAW_README_BYTES||digest(bytes)!==(rawSource.sha256||rawSource.evidence?.sha256)||digest(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]),'sha1')!==declared.gitBlobSha)throw new Error('Pinned raw README bytes do not match declared size and Git blob');
  return declared;
}

// Preserve the old ordering for ordinary API/base64 records. Raw README content
// outranks its encoding:none API stub, which stays retained as provenance proof.
export function repositoryReadmeRefs(item){
  const refs=item.repositoryEvidence||[],raw=refs.filter(ref=>rawReadmeIdentity(ref.url));
  return [...new Set([item.graphqlReadmeProof?.evidenceId,...raw.map(ref=>ref.id),...refs.filter(ref=>/\/readme(?:\?|$)/i.test(ref.url||'')&&ref.id!==item.repositoryReadmeProof?.apiEvidence?.id).map(ref=>ref.id)].filter(Boolean))];
}
