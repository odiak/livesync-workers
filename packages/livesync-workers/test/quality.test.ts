import { describe, it, expect, vi } from "vitest";
import { REQUEST_LIMITS, readBoundedText, readBoundedJson, assertBulkLimits, assertDocumentSize } from "../src/livesync/limits.js";
import { mapBatches, limitConcurrency } from "../src/storage/concurrency.js";
import { matchesSelector, matchesMetadata } from "../src/durable/selector.js";

describe("bounded input", () => {
  it.each(["{", "null", "[]", "42"])("rejects invalid JSON objects: %s", async body => {
    await expect(readBoundedJson(new Request("https://test", {method: "POST", body}))).rejects.toThrow();
  });
  it("counts actual streamed UTF-8 bytes and cancels excess input", async () => {
    let cancelled = false;
    const request = new Request("https://test", { method: "POST", headers: {"Content-Length": "1"},
      body: new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode("字😀")); }, cancel() { cancelled = true; } }), duplex: "half" } as RequestInit);
    await expect(readBoundedText(request, 10)).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("accepts the exact byte boundary", async () => {
    await expect(readBoundedText(new Request("https://test", { method: "POST", body: "字😀" }), 7)).resolves.toBe("字😀");
    expect(() => assertBulkLimits({ docs: Array(REQUEST_LIMITS.maxBulkDocuments + 1).fill({}) })).toThrow();
    expect(() => assertDocumentSize({data: "字".repeat(REQUEST_LIMITS.maxDocumentBytes / 3)})).toThrow();
  });
});

describe("bounded concurrent I/O", () => {
  it("settles already started work before rejecting and does not start another batch", async () => {
    const done: number[] = [];
    await expect(mapBatches([0,1,2], 2, async n => {
      if (n === 0) throw new Error("failed");
      await new Promise(r => setTimeout(r, 5)); done.push(n); return n;
    })).rejects.toThrow("failed");
    expect(done).toEqual([1]);
  });
  it("shares one concurrency budget and releases permits after errors", async () => {
    const bounded = limitConcurrency(2); let active = 0, peak = 0;
    const work = vi.fn(async () => { active++; peak = Math.max(active,peak); await new Promise(r => setTimeout(r,1)); active--; });
    await Promise.all(Array.from({length: 9}, () => bounded(work)));
    expect(peak).toBe(2); expect(active).toBe(0);
  });
});

describe("selector safety and metadata equivalence", () => {
  it.each(["(a+)+$", "((a+))+$", "(a|aa)*$", "(a)\\1", "a".repeat(257)])("rejects expensive pattern %s", pattern => {
    expect(matchesSelector({ data: "a".repeat(100) + "!" }, {data: {$regex: pattern}})).toBe(false);
  });
  it("handles boolean metadata predicates and falls back for null/missing fields", () => {
    const row = {id: "a", rev: "1-a", deleted: 0};
    const metadata = {type: "plain", path: "a.md", size: 8, mtime: null, soft_deleted: 0};
    expect(matchesMetadata(row, metadata, {$and: [{type: "plain"}, {size: {$gte: 8}}, {_id: "a"}]})).toBe(true);
    expect(matchesMetadata(row, metadata, {mtime: {$exists: false}})).toBeUndefined();
    expect(matchesMetadata(row, metadata, {$or: [{path: "a.md"}, {data: "unknown"}]})).toBe(true);
  });
});

import { handleLiveSyncRequest } from "../src/livesync/handler.js";
import { AuthThrottledError } from "../src/livesync/limits.js";
import { DEFAULT_VAULT_POLICY } from "../src/types.js";
it("decodes UTF-8 Basic credentials and preserves CORS on throttling", async () => {
  const verifyCredential = vi.fn(async (user: string, pass: string) => user === "海渡" && pass === "秘密😀" ? {tenantId:"人",databaseName:"vault"} : null);
  const host = {verifyCredential,internalSecret:"secret",loadVaultPolicy:async()=>DEFAULT_VAULT_POLICY};
  const stub = {fetch:vi.fn(async()=>Response.json({ok:true}))};
  const bindings = {vaultDb:{idFromName:vi.fn(name=>name),get:()=>stub} as unknown as DurableObjectNamespace};
  const headers = {Authorization:`Basic ${Buffer.from("海渡:秘密😀").toString("base64")}`, Origin:"app://obsidian.md"};
  expect((await handleLiveSyncRequest(new Request("https://worker/livesync/vault",{headers}),{host,bindings})).status).toBe(200);
  expect(verifyCredential).toHaveBeenCalledWith("海渡","秘密😀");
  verifyCredential.mockRejectedValue(new AuthThrottledError(60));
  const denied=await handleLiveSyncRequest(new Request("https://worker/livesync/vault",{headers}),{host,bindings});
  expect(denied.status).toBe(429);expect(denied.headers.get("Retry-After")).toBe("60");expect(denied.headers.get("Access-Control-Allow-Origin")).toBe("app://obsidian.md");
});
it("splits keyed all_docs calls and preserves the requested order", async () => {
  const pages:number[]=[];
  const stub={fetch:async(request:Request)=>{const keys=JSON.parse(new URL(request.url).searchParams.get("keys")!);pages.push(keys.length);return Response.json({total_rows:400,rows:keys.map((key:string)=>({key}))});}};
  const keys=Array.from({length:1704},(_,i)=>`h:${1703-i}`);
  const response=await handleLiveSyncRequest(new Request(`https://worker/livesync/vault/_all_docs?keys=${encodeURIComponent(JSON.stringify(keys))}`,{headers:{Authorization:`Basic ${btoa("a:b")}`}}),{
    host:{verifyCredential:async()=>({tenantId:"a",databaseName:"vault"}),internalSecret:"secret",loadVaultPolicy:async()=>DEFAULT_VAULT_POLICY},
    bindings:{vaultDb:{idFromName:()=>"a:vault",get:()=>stub} as unknown as DurableObjectNamespace},
  });
  expect(pages).toEqual([...Array(13).fill(128),40]);
  expect((await response.json() as {rows:{key:string}[]}).rows.map(row=>row.key)).toEqual(keys);
});
