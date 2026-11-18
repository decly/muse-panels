// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. `createActionClient` returns a proxy that POSTs `{action, args}`
// to `./actions` and returns the typed response.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (bun:sqlite, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.

import type { Actions } from "../../server/src/actions";
import { createActionClient } from "@hatch/space-sdk/client";

// Resolve the actions endpoint against the directory that served this
// page instead of relying on the SDK default, which resolves "./actions"
// against the raw document URL. Per RFC 3986, when the shell serves the
// page at a path WITHOUT a trailing slash (e.g. ".../spaces/v2/<slug>",
// the shape the sidebar embed uses), the last segment is treated as a
// file name and "./actions" resolves one directory up — every action
// call then misses the space's endpoint and the board cannot load any
// data. Normalizing the base to a directory first (strip a trailing
// "index.html", otherwise ensure a trailing "/") keeps the endpoint at
// "<page directory>/actions" for every hosting shape: trailing slash,
// bare slug path, or explicit index.html. When the URL already ends in
// "/" the result is byte-identical to the SDK default.
function resolveActionsEndpoint(): string {
  const base = new URL(window.location.href);
  base.hash = "";
  base.search = "";
  if (base.pathname.endsWith("/index.html")) {
    base.pathname = base.pathname.slice(0, -"index.html".length);
  } else if (!base.pathname.endsWith("/")) {
    base.pathname += "/";
  }
  return new URL("actions", base).toString();
}

function createApi() {
  try {
    return createActionClient<typeof Actions>({
      endpoint: resolveActionsEndpoint(),
    });
  } catch {
    // Unparseable document URL: fall back to the SDK's default resolution.
    return createActionClient<typeof Actions>();
  }
}

export const api = createApi();

// Re-exported for convenience so client code can do
//
//     import { api, type ApiResponse } from "./api";
//     type Article = ApiResponse<typeof api, "listArticles">["articles"][number];
//
// They are also available directly from "@hatch/space-sdk/client".
export type { ApiRequest, ApiResponse } from "@hatch/space-sdk/client";
