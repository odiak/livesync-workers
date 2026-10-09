import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Only public grant metadata is returned, never token material or encrypted props. */
export async function listMcpConnections(provider: OAuthHelpers, userId: string) {
  const connections = [];
  let cursor: string | undefined;
  do {
    const page = await provider.listUserGrants(userId, { cursor, limit: 100 });
    for (const grant of page.items) {
      if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now() / 1000) continue;
      const metadata = grant.metadata as { clientName?: unknown } | undefined;
      connections.push({
        id: grant.id,
        clientId: grant.clientId,
        clientName: typeof metadata?.clientName === "string" ? metadata.clientName : grant.clientId,
        scopes: grant.scope,
        createdAt: new Date(grant.createdAt * 1000).toISOString(),
        expiresAt: grant.expiresAt === undefined ? null : new Date(grant.expiresAt * 1000).toISOString(),
      });
    }
    cursor = page.cursor;
  } while (cursor);
  return connections.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
