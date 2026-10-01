import {readFile,stat} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {validatePublicCatalogue} from './public-catalogue.mjs';

const MAX_BYTES=192*1024*1024;
// Offline source releases compress their public snapshot to keep a normal Git
// checkout practical. The online consent/sync protocol remains ordinary JSON.
export async function readPublicCatalogueFile(file,{maxBytes=MAX_BYTES}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_BYTES)throw Error('Invalid catalogue file size bound');
  const info=await stat(file);if(!info.isFile()||info.size>maxBytes)throw Error('Catalogue file exceeds its size limit');
  let bytes=await readFile(file);if(bytes.length>maxBytes)throw Error('Catalogue file exceeds its size limit');
  if(bytes[0]===0x1f&&bytes[1]===0x8b){try{bytes=gunzipSync(bytes,{maxOutputLength:maxBytes});}catch{throw Error('Compressed catalogue is invalid or exceeds its size limit');}}
  return validatePublicCatalogue(bytes.toString('utf8'));
}
