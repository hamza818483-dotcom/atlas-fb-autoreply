// ATLAS FB Comment Auto-Reply Worker
// Routes:
//   GET  /webhook  -> Meta webhook verification
//   POST /webhook  -> receives comment change events, matches keyword, replies via Graph API
//   GET  /keywords -> list keyword->reply map (JSON)
//   POST /keywords -> add/update {keyword, reply}
//   DELETE /keywords -> remove {keyword}
// Env bindings required:
//   KV: KEYWORDS (KV namespace)
//   VERIFY_TOKEN, PAGE_ACCESS_TOKEN, ADMIN_SECRET (secrets)

const GRAPH = "https://graph.facebook.com/v19.0";

async function getKeywordMap(env) {
  const raw = await env.KEYWORDS.get("map");
  return raw ? JSON.parse(raw) : {};
}

function matchKeyword(text, map) {
  const lower = text.toLowerCase();
  for (const kw of Object.keys(map)) {
    if (lower.includes(kw.toLowerCase())) return map[kw];
  }
  return null;
}

async function replyToComment(commentId, message, env) {
  const url = `${GRAPH}/${commentId}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      access_token: env.PAGE_ACCESS_TOKEN,
    }),
  });
  return res.json();
}

function checkAdmin(req, env) {
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${env.ADMIN_SECRET}`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // --- Webhook verification ---
    if (req.method === "GET" && url.pathname === "/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // --- Webhook event receiver ---
    if (req.method === "POST" && url.pathname === "/webhook") {
      const body = await req.json();
      try {
        if (body.object === "page") {
          for (const entry of body.entry || []) {
            for (const change of entry.changes || []) {
              if (change.field === "feed" && change.value?.item === "comment" && change.value?.verb === "add") {
                const commentId = change.value.comment_id;
                const text = change.value.message || "";
                const map = await getKeywordMap(env);
                const reply = matchKeyword(text, map);
                if (reply && commentId) {
                  await replyToComment(commentId, reply, env);
                }
              }
            }
          }
        }
      } catch (e) {
        // swallow errors so Meta doesn't retry-storm; log via console
        console.error("webhook processing error", e);
      }
      // Meta requires fast 200 OK
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    // --- Keyword management API (admin-secret protected) ---
    if (url.pathname === "/keywords") {
      if (req.method === "GET") {
        const map = await getKeywordMap(env);
        return Response.json(map);
      }
      if (!checkAdmin(req, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (req.method === "POST") {
        const { keyword, reply } = await req.json();
        if (!keyword || !reply) return new Response("keyword and reply required", { status: 400 });
        const map = await getKeywordMap(env);
        map[keyword] = reply;
        await env.KEYWORDS.put("map", JSON.stringify(map));
        return Response.json({ ok: true, map });
      }
      if (req.method === "DELETE") {
        const { keyword } = await req.json();
        const map = await getKeywordMap(env);
        delete map[keyword];
        await env.KEYWORDS.put("map", JSON.stringify(map));
        return Response.json({ ok: true, map });
      }
    }

    // --- Generic Graph API proxy (for n8n to route around unstable outbound networks) ---
    // POST /proxy/:commentId/:endpoint  body: { message }
    // Requires Authorization: Bearer <ADMIN_SECRET>
    if (req.method === "POST" && url.pathname.startsWith("/proxy/")) {
      try {
        if (!checkAdmin(req, env)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const parts = url.pathname.split("/").filter(Boolean); // ["proxy", commentId, endpoint]
        const commentId = parts[1];
        const endpoint = parts[2]; // "comments" or "private_replies"
        if (!commentId || !endpoint) {
          return new Response("Usage: /proxy/:commentId/:endpoint", { status: 400 });
        }
        const { message } = await req.json();
        if (!message) return new Response("message required", { status: 400 });

        const graphUrl = `${GRAPH}/${commentId}/${endpoint}`;
        const res = await fetch(graphUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            access_token: env.PAGE_ACCESS_TOKEN,
          }),
        });
        const data = await res.json();
        return Response.json(data, { status: res.status });
      } catch (e) {
        return Response.json({ error: true, message: e.message, stack: e.stack }, { status: 500 });
      }
    }

    return new Response("ATLAS FB Auto-Reply Worker", { status: 200 });
  },
};
