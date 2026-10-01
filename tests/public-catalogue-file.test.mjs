import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {createPublicCatalogue} from '../src/public-catalogue.mjs';
import {readPublicCatalogueFile} from '../src/public-catalogue-file.mjs';
test('offline plain and compressed snapshots retain strict validation and identical content hashes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'glasses-compressed-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {snapshot}=createPublicCatalogue({capabilities:[],evidence:[],assessments:[],generatedAt:'2026-10-01T00:00:00.000Z'}),body=JSON.stringify(snapshot);
 await writeFile(join(dir,'pack.json'),body);await writeFile(join(dir,'pack.json.gz'),gzipSync(body));
 assert.deepEqual(await readPublicCatalogueFile(join(dir,'pack.json')),snapshot);assert.deepEqual(await readPublicCatalogueFile(join(dir,'pack.json.gz')),snapshot);
 await writeFile(join(dir,'tampered.gz'),gzipSync(body.replace(snapshot.contentHash,'0'.repeat(64))));await assert.rejects(readPublicCatalogueFile(join(dir,'tampered.gz')));
 await writeFile(join(dir,'large.gz'),gzipSync(' '.repeat(5000)));await assert.rejects(readPublicCatalogueFile(join(dir,'large.gz'),{maxBytes:1024}),/size limit/);
 await writeFile(join(dir,'broken.gz'),Buffer.from([0x1f,0x8b,0,1]));await assert.rejects(readPublicCatalogueFile(join(dir,'broken.gz')),/invalid/);
});
