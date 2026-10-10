/**
 * The one logger every OpenBot process shares. pino underneath, JSON one line per
 * record on stdout, so `docker logs`, `.logs/*.log` and a future collector all read
 * the same shape. A TTY gets pino-pretty instead, because a developer's terminal is
 * not a log sink. Service names ("server", "worker", …) distinguish processes that
 * would otherwise interleave identically-shaped lines in a shared `docker logs`.
 *
 * Per-request context (request_id, trace_id) is attached with `.child(...)`, never
 * by string interpolation — the sweep that adopts this logger moves interpolated
 * values into structured fields (see the P1 plan's transformation rules).
 */
import pino from "pino";

export type Logger = pino.Logger;

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace"]);

export function readLogLevel(
  raw: string | undefined,
  fallback: pino.Level,
): pino.Level {
  const candidate = raw?.trim().toLowerCase();
  return candidate && LEVELS.has(candidate)
    ? (candidate as pino.Level)
    : fallback;
}

export function createLogger(
  service: string,
  stream?: pino.DestinationStream,
): Logger {
  const level = readLogLevel(
    process.env.LOG_LEVEL ?? process.env.OPENBOT_LOG_LEVEL,
    "info",
  );
  const pretty =
    !stream && process.stdout.isTTY && process.env.OPENBOT_LOG_FORMAT !== "json"
      ? pino.transport({
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        })
      : stream;
  return pino({ level, base: { service } }, pretty);
}

const memo = new Map<string, Logger>();

export function getLogger(service: string): Logger {
  let logger = memo.get(service);
  if (!logger) {
    logger = createLogger(service);
    memo.set(service, logger);
  }
  return logger;
}
