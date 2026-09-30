import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {projectPublicArtifacts} from '../src/public-artifacts.mjs';
import {publicCatalogueSchema} from '../src/public-catalogue.mjs';

const hash=(value,algorithm='sha256')=>createHash(algorithm).update(value).digest('hex');
const at='2026-09-30T03:00:00.000Z',rev='a'.repeat(40),treeSha='b'.repeat(40),repo='example/agent-tools',url=`https://github.com/${repo}`;
const mit='MIT License\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software. The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.';
const apache='Apache License\nVersion 2.0, January 2004\n2. Grant of Copyright License. Each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license.';
const document=`---
name: Source review
description: Review a proposed change. Use when the user needs source review.
---
# Source review
## When to use
- Review a proposed change with public source evidence.
## Inputs
- A proposed change and its repository.
## Outputs
- A list of concrete findings.
## Compatibility
- A client that can read skill instructions.
## Review steps
Read the cited public source before reporting findings.
\`\`\`js
DO_NOT_PUBLISH_CODE()
\`\`\`
## Installation
npx PRIVATE_INSTALL_COMMAND
`;
function fixture(options={}){
  const revision=options.revision||rev,branch=options.branch||'main',path=options.path||'skills/review/SKILL.md',licensePath=options.licensePath||'LICENSE';
  const evidence=[],files=[];
  function retain(endpoint,value,encoding='utf8'){
    const body=typeof value==='string'?value:JSON.stringify(value),bytes=Buffer.from(body),sha256=hash(bytes);
    const wrapper={url:endpoint,sha256,status:200,fetchedAt:at,...encoding==='base64'?{encoding,bodyBase64:bytes.toString('base64')}:{body}};
    evidence.push(wrapper);return{url:endpoint,sha256};
  }
  function file(path,body,encoding='utf8'){
    const bytes=Buffer.from(body),gitBlobSha=hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]),'sha1');
    const descriptor={...retain(`https://raw.githubusercontent.com/${repo}/${revision}/${path}`,body,encoding),path,bytes:bytes.length,gitBlobSha,encoding};
    files.push({path,type:'blob',mode:'100644',sha:gitBlobSha,size:bytes.length});return descriptor;
  }
  const sourceDocument=file(path,options.document||document),licenseDocument=file(licensePath,options.license||mit);
  const supporting=(options.extraFiles||[]).map(([path,body,encoding])=>file(path,body,encoding));
  const metadataEvidence=retain(`https://api.github.com/repos/${repo}`,{private:false,archived:false,disabled:false,html_url:url,default_branch:branch,stargazers_count:1000});
  const commitEvidence=retain(`https://api.github.com/repos/${repo}/commits/${branch}`,{sha:revision,commit:{tree:{sha:treeSha}}});
  const treeEvidence=retain(`https://api.github.com/repos/${repo}/git/trees/${treeSha}?recursive=1`,{sha:treeSha,truncated:false,tree:files});
  const source={repository:repo,url,revision,defaultBranch:branch,metadataEvidence,commitEvidence,treeEvidence};
  const entry={artifact:options.artifact||'agent-skill',parent:{repository:repo,url},revision,sourcePath:path,sourceDocument,description:'INVENTED_MANIFEST_DESCRIPTION',inputs:['INVENTED_INPUT'],compatibility:[{agent:'INVENTED_CLIENT'}],acquisition:{files:[sourceDocument,...supporting],supportingFiles:supporting},license:{spdx:options.spdx||'MIT',scope:licensePath.includes('/')?'directory':'repository',scopePath:licensePath.includes('/')?licensePath.slice(0,licensePath.lastIndexOf('/')):'',sourceDocument:licenseDocument,redistribution:'scoped-licence-observed'}};
  const manifest={schemaVersion:1,sources:[source],items:[entry]},parents=[{id:hash(url).slice(0,20),url,name:'Example source tools',privateLocalData:'PRIVATE_LOCAL_DATA'}];
  function rewrite(descriptor,mutate){const wrapper=evidence.find(row=>row.url===descriptor.url&&row.sha256===descriptor.sha256),value=JSON.parse(wrapper.body);mutate(value);wrapper.body=JSON.stringify(value);wrapper.sha256=hash(wrapper.body);descriptor.sha256=wrapper.sha256;}
  return{manifest,evidence,parents,entry,source,files,rewrite};
}
const project=f=>projectPublicArtifacts(f);
const expectExcluded=(f,reason)=>{const result=project(f);assert.equal(result.items.length,0);assert.equal(result.report.excluded[0].reason,reason);};

test('projects a source-backed skill with stable identity, pinned acquisition source and explicit usage',()=>{
  const f=fixture(),before=JSON.stringify(f),result=project(f),row=result.items[0];
  assert.deepEqual(result.report,{examined:1,projected:1,excluded:[]});
  assert.equal(row.url,`${url}/blob/main/skills/review/SKILL.md`);assert.equal(row.id,hash(row.url).slice(0,20));
  assert.equal(row.details.sourceUrl,`${url}/blob/${rev}/skills/review/SKILL.md`);assert.equal(row.kind,'pattern');assert.equal(row.details.resourceType,'skill');
  assert.equal(row.details.parent.id,f.parents[0].id);assert.equal(row.github,null,'Child must not borrow repository stars');
  assert.deepEqual(row.license,{spdx:'MIT',status:'known',scope:'source-artifact',basis:'source-declaration'});
  assert.deepEqual(row.details.agentUsage.inputs,['A proposed change and its repository.']);assert.deepEqual(row.details.agentUsage.outputs,['A list of concrete findings.']);
  assert.deepEqual(row.details.agentUsage.compatibility,['A client that can read skill instructions.']);
  assert.ok(!JSON.stringify(row).match(/INVENTED_|PRIVATE_|DO_NOT_PUBLISH_CODE|body|evidenceFile/));
  assert.ok(row.citations.every(c=>c.recordUrl===row.url&&!new URL(c.endpoint).search));assert.ok(row.details.citationIds.every(id=>row.citations.some(c=>c.id===id)));
  assert.equal(JSON.stringify(f),before);assert.ok(publicCatalogueSchema.shape.items.element.safeParse(row).success);
});

test('agent profiles have a separate resource type and preserve safe description before an inline command',()=>{
  const f=fixture({artifact:'agent-profile',path:'agents/reviewer.agent.md',document:document.replace('Review a proposed change. Use when the user needs source review.','Review a proposed change. Run `tool /init` to start.')}),row=project(f).items[0];
  assert.equal(row.details.resourceType,'agent');assert.equal(row.description,'Review a proposed change.');assert.equal(row.details.overview,'Review a proposed change.');
});

test('verified upstream revision changes replace the same stable branch/path card',()=>{
  const a=project(fixture()).items[0],b=project(fixture({revision:'c'.repeat(40),document:document.replace('Review a proposed change.','Review a proposed code change.')})).items[0];
  assert.equal(a.id,b.id);assert.equal(a.url,b.url);assert.notEqual(a.details.sourceUrl,b.details.sourceUrl);assert.notEqual(a.citations[0].sha256,b.citations[0].sha256);
});

test('no manifest prose or unrecognised document content can invent inputs, outputs or compatibility',()=>{
  const f=fixture({document:'---\nname: Review\ndescription: A source reviewer.\n---\n# Review\nGeneral review prose without an input/output contract.'}),row=project(f).items[0];
  assert.equal(row.details.agentUsage,undefined);assert.ok(!JSON.stringify(row).includes('INVENTED'));
});

test('repository public status, canonical identity and projected parent are required',()=>{
  for(const change of [m=>{m.private=true;},m=>{m.archived=true;},m=>{m.disabled=true;},m=>{m.html_url='https://github.com/other/tools';}]){const f=fixture();f.rewrite(f.source.metadataEvidence,change);expectExcluded(f,'repository-not-public-active');}
  const f=fixture();f.parents=[];expectExcluded(f,'missing-projected-parent');
  const altered=fixture();altered.parents[0].id='c'.repeat(20);expectExcluded(altered,'missing-projected-parent');
});

test('commit, explicit complete tree and regular file are independently bound',()=>{
  const commit=fixture();commit.rewrite(commit.source.commitEvidence,data=>{data.sha='d'.repeat(40);});expectExcluded(commit,'commit-identity');
  for(const change of [t=>{t.truncated=true;},t=>{t.sha='c'.repeat(40);},t=>{t.tree.push(t.tree[0]);}]){const f=fixture();f.rewrite(f.source.treeEvidence,change);assert.equal(project(f).items.length,0);}
  for(const mode of ['120000','160000']){const f=fixture();f.rewrite(f.source.treeEvidence,t=>{t.tree[0].mode=mode;});expectExcluded(f,'source-not-regular-tree-file');}
  const f=fixture();const old=f.source.treeEvidence.url;f.source.treeEvidence.url=old.replace(treeSha,rev);f.evidence.find(s=>s.url===old).url=f.source.treeEvidence.url;expectExcluded(f,'incomplete-source-tree');
});

test('raw document hash, blob SHA, byte length and immutable URL must agree',()=>{
  for(const mutate of [f=>{f.evidence.find(s=>s.url===f.entry.sourceDocument.url).body+='tampered';},f=>{f.entry.sourceDocument.gitBlobSha='d'.repeat(40);},f=>{f.entry.sourceDocument.bytes++;},f=>{f.entry.sourceDocument.url=f.entry.sourceDocument.url.replace(rev,'main');},f=>{f.entry.sourceDocument.url=f.entry.sourceDocument.url.replace(repo,'other/tools');}]){const f=fixture();mutate(f);assert.equal(project(f).items.length,0);}
});

test('invalid paths, branch injection, wrong extension and mismatched entry/document paths are rejected',()=>{
  for(const path of ['../SKILL.md','skills/../SKILL.md','F:/private/SKILL.md','skills/%2e%2e/SKILL.md','skills/review/README.md']){const f=fixture({path});assert.equal(project(f).items.length,0);}
  const branch=fixture({branch:'../private'});expectExcluded(branch,'invalid-default-branch');
  const mismatch=fixture();mismatch.entry.sourcePath='another/SKILL.md';expectExcluded(mismatch,'entry-document-path-mismatch');
});

test('source description and frontmatter stay safe, declared and unambiguous',()=>{
  for(const body of [document.replace('description:','name: Duplicate\ndescription:'),document.replace('Review a proposed change. Use when the user needs source review.','F:\\Secret\\profile'),document.replace('name: Source review','name: &alias'),document.replace(/^---[\s\S]*?---\n/,'' )]){const f=fixture({document:body});assert.equal(project(f).items.length,0);}
});

test('a nearest directory Apache licence is valid without licensing the containing proprietary plugin',()=>{
  const f=fixture({licensePath:'skills/review/LICENSE.txt',license:apache,spdx:'Apache-2.0',extraFiles:[['LICENSE','Proprietary all rights reserved.'],['plugin.json','{"license":"Proprietary"}']]});f.entry.acquisition.files=[f.entry.sourceDocument];f.entry.acquisition.supportingFiles=[];const row=project(f).items[0];
  assert.ok(row);assert.equal(row.license.spdx,'Apache-2.0');assert.equal(row.license.scope,'source-artifact');assert.ok(!JSON.stringify(row).includes('Proprietary'));
});

test('a directory-scoped licence never covers a proposed support file outside that scope',()=>{
  const f=fixture({licensePath:'skills/review/LICENSE.txt',license:apache,spdx:'Apache-2.0',extraFiles:[['plugin.json','{"license":"Proprietary"}']]});expectExcluded(f,'package-file-outside-licence-scope');
});

test('a closer or ambiguous licence cannot be ignored to borrow a permissive ancestor',()=>{
  const closer=fixture({extraFiles:[['skills/review/LICENSE.txt','Proprietary all rights reserved.']]});expectExcluded(closer,'closer-or-ambiguous-licence');
  const ambiguous=fixture({extraFiles:[['LICENSE.md',apache]]});expectExcluded(ambiguous,'closer-or-ambiguous-licence');
  const scope=fixture({licensePath:'unrelated/LICENSE'});expectExcluded(scope,'licence-outside-artifact-scope');
});

test('full declared licence grant and lack of conflicting restrictions are mandatory',()=>{
  for(const license of ['MIT',mit+'\nCommons Clause: no commercial use',apache]){const f=fixture({license});assert.equal(project(f).items.length,0);}
  const f=fixture({document:document.replace('name: Source review','name: Source review\nlicense: Proprietary')});expectExcluded(f,'conflicting-document-licence');
});

test('package source counts deduplicate support descriptors, validate binaries and reject corrupt extra files',()=>{
  const f=fixture({extraFiles:[['skills/review/icon.png','BINARY_DATA','base64']]}),row=project(f).items[0];assert.equal(row.details.sourceFileCount,2);assert.ok(!JSON.stringify(row).includes('BINARY_DATA'));
  const descriptor=f.entry.acquisition.supportingFiles[0];descriptor.gitBlobSha='e'.repeat(40);assert.equal(project(f).items.length,0);
});

test('duplicate stable artifact cards are omitted with a fixed diagnostic instead of duplicated',()=>{
  const f=fixture();f.manifest.items.push(structuredClone(f.entry));const result=project(f);assert.equal(result.items.length,1);assert.deepEqual(result.report.excluded,[{index:1,reason:'duplicate-artifact-identity'}]);
});

test('published descriptive sections are bounded and never include code or installation blocks',()=>{
  const prose=Array.from({length:20},(_,i)=>`## Section ${i}\n${'A supported source description. '.repeat(60)}`).join('\n'),f=fixture({document:document+'\n'+prose}),row=project(f).items[0];
  assert.ok(row.details.sections.length<=6);assert.ok([row.details.overview,...row.details.sections.map(s=>s.summary)].join(' ').split(/\s+/).length<=180);
  assert.ok(!JSON.stringify(row).includes('PRIVATE_INSTALL_COMMAND'));assert.ok(publicCatalogueSchema.shape.items.element.safeParse(row).success);
});
