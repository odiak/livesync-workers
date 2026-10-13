import { sha256Hex } from "../credentials.js";

type NamedStub = DurableObjectStub & { setName(name: string, props?: unknown): Promise<void> };

type SessionPrincipal = { userId: string; scope: string[] };

/** Keep a warm MCP object's props specific to the authenticated user and token scopes. */
export function withMcpSessionIsolation<Env>(
  handler: ExportedHandler<Env>,
  bindingName: keyof Env,
): ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>["fetch"]> } {
  return {
    async fetch(request, env, ctx) {
      // Preflight never selects a session object.
      if (request.method === "OPTIONS") return handler.fetch!(request, env, ctx);
      const principal = (ctx as ExecutionContext & { props?: SessionPrincipal }).props;
      if (!principal?.userId || !Array.isArray(principal.scope)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const partition = await sha256Hex(
        JSON.stringify([principal.userId, [...new Set(principal.scope)].sort()]),
      );
      const namespace = env[bindingName] as DurableObjectNamespace;
      // McpAgent names objects `transport:sessionId`. A suffix preserves the
      // session ID on the wire while making each user/scope combination distinct.
      const isolated = new Proxy(namespace, {
        get(target, property) {
          if (property === "idFromName") {
            return (name: string) => target.idFromName(`${name}:${partition}`);
          }
          if (property === "get") {
            return (...args: Parameters<typeof target.get>) => {
              const stub = target.get(...args) as NamedStub;
              return new Proxy(stub, {
                get(object, method) {
                  // PartyServer compares setName to ctx.id.name; both must
                  // include the same partition suffix.
                  if (method === "setName") {
                    return (name: string, props?: unknown) => object.setName(`${name}:${partition}`, props);
                  }
                  const value = Reflect.get(object, method, object);
                  // RPC methods treat property reads such as .bind as remote methods.
                  return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, object, args) : value;
                },
              });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return handler.fetch!(request, { ...env, [bindingName]: isolated }, ctx);
    },
  };
}
