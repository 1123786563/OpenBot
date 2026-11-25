# The framework Bot. Same shape as agent-bot and the same absence of a browser: this process speaks
# AG-UI and talks to a model, and the computer it drives is a separate container with its own
# lifecycle. Two Bots in the box rather than one, so "any AG-UI agent is a Bot" is demonstrated by
# two implementations that share nothing but the protocol.
FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY agent-langgraph/package.json agent-langgraph/bun.lock ./agent-langgraph/
RUN cd agent-langgraph && bun install --frozen-lockfile

# The repo's own layout, kept exactly, so `../../shared/bot-prompt` resolves the same here as it
# does on a laptop. Flattening src to /app/src would change the depth and break only on deploy.
COPY shared ./shared
COPY agent-langgraph/src ./agent-langgraph/src

ENV PORT=4201
EXPOSE 4201
CMD ["bun", "agent-langgraph/src/index.ts"]
