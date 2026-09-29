import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function createIntelligenceStore(dataDir) {
  const directory=resolve(dataDir);mkdirSync(directory,{recursive:true,mode:0o700});
  const db=new DatabaseSync(join(directory,'intelligence.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const tables=new Set(['jobs','assessments','corrections','cache','usage','settings']);
  for(const table of tables)db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY,data TEXT NOT NULL)`);
  const check=table=>{if(!tables.has(table))throw new Error('Unknown intelligence table');};
  return {
    get(table,id){check(table);const row=db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(row.data):null;},
    all(table){check(table);return db.prepare(`SELECT data FROM ${table}`).all().map(row=>JSON.parse(row.data));},
    save(table,value){check(table);db.prepare(`INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id,JSON.stringify(value));return structuredClone(value);},
    close(){db.close();}
  };
}
