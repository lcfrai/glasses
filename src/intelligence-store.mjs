import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function createIntelligenceStore(dataDir) {
  const directory=resolve(dataDir);mkdirSync(directory,{recursive:true,mode:0o700});
  const db=new DatabaseSync(join(directory,'intelligence.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const tables=new Set(['jobs','assessments','corrections','cache','usage','settings']);
  for(const table of tables)db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY,data TEXT NOT NULL)`);
  for(const table of ['jobs','usage'])db.exec(`CREATE INDEX IF NOT EXISTS ${table}_created_at ON ${table}(json_extract(data,'$.createdAt'))`);
  db.exec("CREATE INDEX IF NOT EXISTS jobs_status_created_at ON jobs(json_extract(data,'$.status'),json_extract(data,'$.createdAt'))");
  const check=table=>{if(!tables.has(table))throw new Error('Unknown intelligence table');};
  return {
    get(table,id){check(table);const row=db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(row.data):null;},
    all(table){check(table);return db.prepare(`SELECT data FROM ${table}`).all().map(row=>JSON.parse(row.data));},
    jobCounts(){const counts=Object.fromEntries(['queued','running','completed','partial','failed','cancelled','interrupted'].map(status=>[status,0]));for(const row of db.prepare("SELECT json_extract(data,'$.status') AS status,count(*) AS count FROM jobs GROUP BY json_extract(data,'$.status')").all())if(row.status in counts)counts[row.status]=row.count;return counts;},
    nextQueuedJob(){const row=db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.status')='queued' ORDER BY json_extract(data,'$.createdAt'),id LIMIT 1").get();return row?JSON.parse(row.data):null;},
    listJobs({limit,offset}){return {items:db.prepare("SELECT data FROM jobs ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT ? OFFSET ?").all(limit,offset).map(row=>JSON.parse(row.data)),total:db.prepare('SELECT count(*) AS count FROM jobs').get().count};},
    usageSummary(day){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('Invalid usage day');
      const start=day+'T00:00:00.000Z',end=new Date(Date.parse(start)+86400000).toISOString();
      const row=db.prepare(`SELECT
        coalesce(sum(CASE WHEN json_extract(data,'$.requestSent')=0 THEN 0 ELSE 1 END),0) AS calls,
        coalesce(sum(CASE WHEN json_extract(data,'$.requestSent')=0 THEN 1 ELSE 0 END),0) AS localRejections,
        coalesce(sum(json_extract(data,'$.inputTokens')),0) AS inputTokens,
        coalesce(sum(json_extract(data,'$.outputTokens')),0) AS outputTokens,
        coalesce(sum(CASE WHEN json_extract(data,'$.provider')='jev' THEN coalesce(json_extract(data,'$.costUsd'),0) ELSE 0 END),0) AS jevCostUsd,
        coalesce(sum(CASE WHEN json_extract(data,'$.provider')='jev' THEN coalesce(json_extract(data,'$.chargedOrReservedUsd'),0) ELSE 0 END),0) AS jevReservedUsd,
        coalesce(sum(CASE WHEN json_extract(data,'$.costUsd') IS NULL THEN 1 ELSE 0 END),0) AS unknownCostCalls
        FROM usage WHERE json_extract(data,'$.createdAt')>=? AND json_extract(data,'$.createdAt')<?`).get(start,end);
      return {...row,jobs:db.prepare("SELECT count(*) AS count FROM jobs WHERE json_extract(data,'$.createdAt')>=? AND json_extract(data,'$.createdAt')<?").get(start,end).count};
    },
    save(table,value){check(table);db.prepare(`INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id,JSON.stringify(value));return structuredClone(value);},
    close(){db.close();}
  };
}
