import { stat } from "node:fs/promises";
import { serve } from "bun";
import { isPersonBrowserId } from "../../shared/openbot-browser";
import { matchesToken, offeredToken } from "./authorisation";
import { seatIdFor } from "./bot-id";
import { handleFileRequest } from "./file-routes";
import { createWorkspace } from "./workspace";

const token = process.env.COMPUTER_TOKEN?.trim();
const root = process.env.WORKSPACE_DIR;
if (!token || !root) throw new Error("Flash file worker configuration missing");
if (!(await stat(root)).isDirectory())
  throw new Error("Flash Workspace mount is unavailable");
const files = createWorkspace(root);

serve({
  port: 4100,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return Response.json({ status: "ok", browser: false, identity: null });
    if (!matchesToken(token, offeredToken(request.headers, url)))
      return Response.json({ error: "Not authorised." }, { status: 401 });

    const bot = request.headers.get("x-openbot-bot-id")?.trim() || "shared";
    const person =
      request.headers.get("x-openbot-person-id")?.trim() || undefined;
    try {
      seatIdFor(bot, person);
    } catch {
      return Response.json(
        { error: "That is not a usable bot id." },
        { status: 400 },
      );
    }
    if (isPersonBrowserId(bot))
      return Response.json(
        { error: "A person's browser needs its own computer." },
        { status: 503 },
      );
    return (
      (await handleFileRequest(request, url, async () => files)) ??
      Response.json({ error: "Not found." }, { status: 404 })
    );
  },
});
