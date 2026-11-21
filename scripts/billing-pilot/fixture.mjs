const eventsByRun = new Map();
const reply = "Offline pilot Bot reply.";

Bun.serve({
  hostname: "0.0.0.0",
  port: 4200,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    const method = request.method;
    if (path.endsWith("/websocket")) {
      if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "phoenix" } })) return;
      return new Response(null, { status: 400 });
    }
    if (path.startsWith("/events/") && method === "GET") {
      const runId = decodeURIComponent(path.slice("/events/".length));
      return Response.json(eventsByRun.get(runId) ?? []);
    }
    if (path === "/ag-ui" && method === "POST") {
      if (request.headers.get("x-openbot-agent-token") !== "pilot-offline-agent") {
        return new Response(null, { status: 401 });
      }
      const { threadId, runId } = await request.json();
      const messageId = `reply-${runId}`;
      const events = [
        { type: "RUN_STARTED", threadId, runId },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: reply },
        { type: "TEXT_MESSAGE_END", messageId },
        { type: "RUN_FINISHED", threadId, runId },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    const [, api, threads, threadId, subresource] = path.split("/");
    if (api === "api" && threads === "threads") {
      if (!threadId && method === "POST") {
        const body = await request.json();
        return Response.json({ thread: { id: body.threadId } });
      }
      if (!subresource && method === "GET") return Response.json({ thread: { id: threadId } });
      if (subresource === "messages" && method === "GET") return Response.json({ messages: [] });
      if (subresource === "lock" && method === "POST") {
        const { runId } = await request.json();
        return Response.json({ threadId, runId, joinToken: "fixture-token", ttlSeconds: 120 });
      }
      if (subresource === "lock" && method === "PATCH") return Response.json({ ttlSeconds: 120 });
      if (subresource === "lock" && method === "DELETE") return new Response(null, { status: 204 });
    }
    console.info(`${method} ${path} -> 404`);
    return Response.json({ error: "Fixture route not found" }, { status: 404 });
  },
  websocket: {
    message(socket, message) {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(message));
      if (event === "event" || event === "events") {
        const entries = event === "event" ? [payload] : payload.events;
        for (const entry of entries) {
          if (typeof entry.runId !== "string") continue;
          const events = eventsByRun.get(entry.runId) ?? [];
          events.push(entry);
          eventsByRun.set(entry.runId, events);
        }
      }
      socket.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
    },
  },
});
