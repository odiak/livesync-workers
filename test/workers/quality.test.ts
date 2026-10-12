import { env, SELF, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { it, expect, afterEach, vi } from "vitest";
import { PersistentVaultDO, type TestEnv } from "./entry.js";
const bindings = env as unknown as TestEnv;
const created: DurableObjectStub[] = [];
async function fixture(name: string) {
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`${name}:vault`));
  created.push(stub);
  expect((await stub.fetch("https://db/", {method: "PUT"})).status).toBe(200);
  return stub;
}
afterEach(async () => { for (const stub of created.splice(0)) await runInDurableObject(stub, (_,state) => state.storage.deleteAlarm()); vi.restoreAllMocks(); });
const post = (stub: DurableObjectStub, docs: unknown[]) => stub.fetch("https://db/_bulk_docs", {method: "POST", body: JSON.stringify({docs, new_edits: false})});
it("persists R2 leaves, history and tombstones across a fresh DO instance", async () => {
  const stub = await fixture("restart");
  const data = "日本語😀".repeat(100);
  expect((await post(stub, [{_id:"h:a",_rev:"1-a",type:"leaf",data}, {_id:"gone",_rev:"2-b",_deleted:true,_revisions:{start:2,ids:["b","a"]}}])).status).toBe(200);
  await runInDurableObject(stub, async (_,state) => {
    expect(state.storage.sql.exec("SELECT * FROM chunk_body_refs").toArray()).toHaveLength(1);
    const fresh = new PersistentVaultDO(state, bindings);
    expect(await (await fresh.fetch(new Request("https://db/h:a"))).json()).toMatchObject({data});
    expect((await fresh.fetch(new Request("https://db/gone"))).status).toBe(404);
  });
});
it("rejects malformed bodies and oversized bulk input before writing", async () => {
  const stub = await fixture("limits");
  for (const body of ["{", "null", "[]"]) expect((await stub.fetch("https://db/_bulk_docs",{method:"POST",body})).status).toBe(400);
  expect((await post(stub,[{_id:"first",_rev:"1-a"},{_id:"too-large",_rev:"1-a",data:"a".repeat(4*1024*1024)}])).status).toBe(413);
  expect((await stub.fetch("https://db/first")).status).toBe(404);
  expect((await stub.fetch("https://db/%ZZ")).status).toBe(400);
});
it("preserves keyed all_docs ordering, duplicates, missing keys and deleted rows", async () => {
  const stub = await fixture("keys");
  await post(stub,[{_id:"a",_rev:"1-a",data:"A"},{_id:"b",_rev:"1-b",_deleted:true}]);
  const response = await stub.fetch(`https://db/_all_docs?include_docs=true&keys=${encodeURIComponent(JSON.stringify(["b","missing","a","a"]))}`);
  const result = await response.json() as {rows: Array<{key:string;error?:string;doc:unknown;value?:{deleted:boolean}}>};
  expect(result.rows.map(r=>r.key)).toEqual(["b","missing","a","a"]);
  expect(result.rows[0]).toMatchObject({doc:null,value:{deleted:true}});
  expect(result.rows[1]?.error).toBe("not_found");
  expect((await stub.fetch("https://db/_all_docs?keys=nope")).status).toBe(400);
});
it("pages initial changes with a stable cursor and actual pending count", async () => {
  const stub = await fixture("pages");
  await post(stub,Array.from({length:130},(_,i)=>({_id:`n${i}`,_rev:"1-a",type:"plain",path:`${i}.md`,data:"text"})));
  const first = await (await stub.fetch("https://db/_changes?include_docs=true&limit=1704")).json() as {results:unknown[];last_seq:number;pending:number};
  expect(first.results).toHaveLength(128); expect(first.pending).toBe(2);
  const next = await (await stub.fetch(`https://db/_changes?include_docs=true&since=${first.last_seq}`)).json() as {results:unknown[];pending:number};
  expect(next.results).toHaveLength(2); expect(next.pending).toBe(0);
});
it("does not expose trusted internal routes through authenticated CouchDB proxy", async () => {
  for (const path of ["internal/op", "%69nternal/op", "internal%2Fop"]) {
    const res=await SELF.fetch(`https://worker/livesync/vault/${path}`,{method:"POST",headers:{Authorization:`Basic ${btoa("alice:integration-pass")}`,"X-LiveSync-Internal":"integration-secret"},body:'{"op":"reindex"}'});
    expect(res.status).toBe(404);
  }
});
it("runs a real alarm and preserves compare-and-swap under simultaneous writes", async () => {
  const stub=await fixture("cas");
  const initial=await (await stub.fetch("https://db/a",{method:"PUT",body:'{"data":"first"}'})).json() as {rev:string};
  const writes=await Promise.all(["second","third"].map(data=>stub.fetch("https://db/a",{method:"PUT",body:JSON.stringify({_rev:initial.rev,data})})));
  expect(writes.map(r=>r.status).sort()).toEqual([200,409]);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
});
it("leaves failed R2 writes invisible and retries safely after restart", async () => {
  const stub=await fixture("r2-failure");
  await runInDurableObject(stub,async (_,state)=>{
    const bucket=new Proxy(bindings.CONTENT,{get(target,key){ if(key==='put') return async()=>{throw new Error('injected R2 failure');}; const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value; }});
    const failing=new PersistentVaultDO(state,{...bindings,CONTENT:bucket});
    const doc={_id:'h:a',_rev:'1-a',type:'leaf',data:'x'.repeat(100)};
    expect((await failing.fetch(new Request('https://db/_bulk_docs',{method:'POST',body:JSON.stringify({docs:[doc],new_edits:false})}))).status).toBe(500);
    expect(state.storage.sql.exec("SELECT * FROM revs WHERE id='h:a'").toArray()).toHaveLength(0);
    const fresh=new PersistentVaultDO(state,bindings);
    expect((await fresh.fetch(new Request('https://db/_bulk_docs',{method:'POST',body:JSON.stringify({docs:[doc],new_edits:false})}))).status).toBe(200);
    expect(await (await fresh.fetch(new Request('https://db/h:a'))).json()).toMatchObject({data:doc.data});
  });
});

it("requires matching trusted identity for a nameless runtime and persists it",async()=>{
  const stub=await fixture("identity-日本語");
  await runInDurableObject(stub,async(_,state)=>{
    const id=new Proxy(state.id,{get(target,key){if(key==='name')return undefined;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const ctx=new Proxy(state,{get(target,key){if(key==='id')return id;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const ref={tenantId:'identity-日本語',databaseName:'vault'};
    const headers={'X-LiveSync-Internal':'integration-secret','X-LiveSync-Vault-Ref':encodeURIComponent(JSON.stringify(ref))};
    const fresh=()=>new PersistentVaultDO(ctx,bindings);
    expect((await fresh().fetch(new Request('https://db/',{headers:{...headers,'X-LiveSync-Internal':'wrong'}}))).status).toBe(400);
    expect((await fresh().fetch(new Request('https://db/',{headers:{...headers,'X-LiveSync-Vault-Ref':encodeURIComponent(JSON.stringify({...ref,tenantId:'other'}))}}))).status).toBe(400);
    expect((await fresh().fetch(new Request('https://db/',{headers}))).status).toBe(200);
    const saved=state.storage.sql.exec<{value:string}>("SELECT value FROM meta WHERE key='vault_identity'").one();
    expect(JSON.parse(saved.value)).toEqual(ref);
    expect((await fresh().fetch(new Request('https://db/h:new',{method:'PUT',body:JSON.stringify({type:'leaf',data:'persist'.repeat(100)})}))).status).toBe(200);
  });
});
it("keeps a successful R2 upload invisible if the SQL transaction fails, then retries",async()=>{
  const stub=await fixture("sql-failure");
  await runInDurableObject(stub,async(_,state)=>{
    let fail=true;
    const storage=new Proxy(state.storage,{get(target,key){if(key==='transactionSync')return <T>(work:()=>T)=>target.transactionSync(()=>{const result=work();if(fail){fail=false;throw new Error('injected SQL rollback');}return result;});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const ctx=new Proxy(state,{get(target,key){if(key==='storage')return storage;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const db=new PersistentVaultDO(ctx,bindings);
    const body=JSON.stringify({docs:[{_id:'h:a',_rev:'1-a',type:'leaf',data:'x'.repeat(100)}],new_edits:false});
    expect((await db.fetch(new Request('https://db/_bulk_docs',{method:'POST',body}))).status).toBe(500);
    expect(state.storage.sql.exec("SELECT * FROM revs WHERE id='h:a'").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec("SELECT * FROM chunk_body_refs WHERE id='h:a'").toArray()).toHaveLength(0);
    expect((await db.fetch(new Request('https://db/_bulk_docs',{method:'POST',body}))).status).toBe(200);
    expect(state.storage.sql.exec("SELECT * FROM chunk_body_refs WHERE id='h:a'").toArray()).toHaveLength(1);
  });
});
