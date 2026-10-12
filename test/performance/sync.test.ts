import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { PersistentVaultDO, type TestEnv } from "../workers/entry.js";
import type { VaultBindings } from "../../packages/livesync-workers/src/types.js";
const bindings = env as unknown as TestEnv;
// Fixed corpus, no AI or remote resources. Change the fixture version when changing data.
const fixtureVersion = 1;
for (const external of [false, true]) it(`reproducible sync/index benchmark: ${external ? "r2-leaves" : "sqlite"}`, async () => {
  const ref = `benchmark-${external}:vault`;
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(ref));
  await runInDurableObject(stub, async (_, state) => {
    const counts = {get:0,put:0,delete:0,list:0,rowsRead:0,rowsWritten:0};
    const measuredBucket = (source: R2Bucket) => new Proxy(source, {get(target,key) {
      const value = Reflect.get(target,key);
      if(typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if(key === "get" || key === "put" || key === "delete" || key === "list") counts[key]++;
        await new Promise(resolve => setTimeout(resolve, 2));
        return value.apply(target,args);
      };
    }});
    const bucket = measuredBucket(bindings.CONTENT);
    const search = measuredBucket(bindings.SEARCH);
    const sql = new Proxy(state.storage.sql, {get(target,key) {
      if(key === "exec") return (...args: Parameters<SqlStorage["exec"]>) => {
        const cursor = target.exec(...args);
        const rows = cursor.toArray();
        counts.rowsRead += cursor.rowsRead;
        counts.rowsWritten += cursor.rowsWritten;
        return {toArray:()=>rows, one:()=>{if(rows.length!==1)throw new Error("Expected one row");return rows[0];}};
      };
      const value = Reflect.get(target,key); return typeof value === "function" ? value.bind(target) : value;
    }});
    const storage = new Proxy(state.storage,{get(target,key){ if(key === "sql")return sql;const value=Reflect.get(target,key);return typeof value === "function"?value.bind(target):value; }});
    const ctx = new Proxy(state,{get(target,key){if(key === "storage")return storage;const value=Reflect.get(target,key);return typeof value === "function"?value.bind(target):value;}});
    class Measured extends PersistentVaultDO {
      protected bindings(): VaultBindings { const base = super.bindings(); return {...base, bucket: search, chunkBucket: external ? bucket : undefined}; }
    }
    let db = new Measured(ctx,bindings);
    (db as unknown as { scheduleIndexing(): Promise<void> }).scheduleIndexing = async () => {};
    await state.storage.deleteAlarm();
    const request = (path:string,body?:unknown,method = body ? "POST" : "GET") => db.fetch(new Request(`https://db${path}`,{method,...(body?{body:JSON.stringify(body)}:{})}));
    await request("/",undefined,"PUT");
    const docs = [
      ...Array.from({length:20},(_,i)=>({_id:`h:${i}`,_rev:"1-a",type:"leaf",data:`${i} 計測 performance\n`.repeat(1000)})),
      ...Array.from({length:96},(_,i)=>({_id:`${i}.md`,_rev:"1-a",path:`${i}.md`,type:"plain",children:[`h:${i%20}`]})),
    ];
    const t = performance.now();
    expect((await request('/_bulk_docs',{docs,new_edits:false})).status).toBe(200);
    const synced = performance.now();
    const beforeGet = counts.get;
    const filtered = await request('/_changes',{selector:{$and:[{type:'plain'},{path:{$exists:true}}]},since:0});
    expect((await filtered.json() as {results:unknown[]}).results).toHaveLength(96);
    expect(counts.get - beforeGet).toBe(0);
    const selected = performance.now();
    for(let i=0;i<6;i++) await db.alarm();
    const indexed = performance.now();
    // Include the built-in FTS publication, independently of the debounce clock.
    state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'fts_rebuild_at'");
    for (let pass = 0; pass < 8; pass++) {
      await db.alarm();
      if (!state.storage.sql.exec("SELECT 1 FROM index_state WHERE fts_hash IS NULL AND hash IS NOT NULL").toArray().length) break;
      state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'fts_rebuild_at'");
    }
    expect(state.storage.sql.exec("SELECT 1 FROM index_state WHERE fts_hash IS NULL AND hash IS NOT NULL").toArray()).toHaveLength(0);
    const searchable = performance.now();
    expect(state.storage.sql.exec("SELECT COUNT(*) n FROM index_state WHERE pending = 1").one()).toMatchObject({n:0});
    db = new Measured(ctx,bindings);
    const read = await request('/h:0');
    expect((await read.json() as {data:string}).data).toContain('計測');
    const reopened = performance.now();
    console.log('LIVESYNC_BENCHMARK '+JSON.stringify({fixtureVersion,variant:external?'r2-leaves':'sqlite',documents:docs.length,notes:96,sharedChunks:20,simulatedR2LatencyMs:2,
      syncMs:synced-t,metadataSelectMs:selected-synced,indexMs:indexed-selected,fullTextMs:searchable-indexed,reopenReadMs:reopened-searchable,totalMs:reopened-t,sqliteBytes:state.storage.sql.databaseSize,...counts}));
    await state.storage.deleteAlarm();
  });
});
