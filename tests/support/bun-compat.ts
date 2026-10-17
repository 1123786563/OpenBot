import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import { Readable } from "node:stream";

/*
 * The slice of the Bun runtime these suites use, on Node.
 *
 * e2e runs on Node (its CLI refuses another runtime), while a number of suites probe the app the
 * way Bun does: spawning children, redirecting their output to files, serving a fetch handler.
 * Installing this as `globalThis.Bun` keeps those suites honest about behaviour instead of
 * dropping the cases. `bun` itself still has to exist on PATH for the suites that run a child Bun.
 */

type Any = any;

function bunBinary(): string {
  const fromPath = whichBun("bun");
  if (fromPath) return fromPath;
  return process.env.BUN_PATH ?? "bun";
}

function whichBun(name: string): string | null {
  const { delimiter = ":", PATH = "" } = process.env;
  const extension =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const directory of PATH.split(delimiter)) {
    if (!directory) continue;
    for (const suffix of extension) {
      const candidate = `${directory}/${name}${suffix.toLowerCase()}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

class NodeBunFile {
  readonly __bunPath: string;
  constructor(path: string) {
    this.__bunPath = path;
  }
  get size(): number {
    try {
      return statSync(this.__bunPath).size;
    } catch {
      return 0;
    }
  }
  get exists(): boolean {
    return existsSync(this.__bunPath);
  }
  existsSync(): boolean {
    return this.exists;
  }
  text(): Promise<string> {
    return Promise.resolve(this.textSync());
  }
  textSync(): string {
    return readFileSync(this.__bunPath, "utf8");
  }
  bytes(): Promise<Uint8Array> {
    return Promise.resolve(readFileSync(this.__bunPath));
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes().then((value) =>
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  json(): Promise<Any> {
    return this.text().then((value) => JSON.parse(value));
  }
  stream(): Readable {
    return createReadStream(this.__bunPath);
  }
}

type StdioTarget =
  | "pipe"
  | "ignore"
  | "overflow"
  | NodeBunFile
  | number
  | null
  | undefined;

interface SpawnOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdin?: StdioTarget;
  stdout?: StdioTarget;
  stderr?: StdioTarget;
  onExit?: (exitCode: number) => void;
}

function target(target: StdioTarget): "pipe" | "ignore" | number {
  if (target instanceof NodeBunFile) {
    mkdirSync(dirname(target.__bunPath), { recursive: true });
    return openSync(target.__bunPath, "w");
  }
  if (typeof target === "number") return target;
  if (target === "pipe") return "pipe";
  return "ignore";
}

function collect(
  stream: Readable | null,
): Promise<string> & { __stream: Readable | null } {
  const chunks: Buffer[] = [];
  const promise = new Promise<string>((resolve, reject) => {
    if (!stream) return resolve("");
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  }) as Promise<string> & { __stream: Readable | null };
  promise.__stream = stream;
  return promise;
}

function run(command: readonly string[], options: SpawnOptions = {}): Any {
  const [executable, ...args] = command as string[];
  const child = nodeSpawn(executable, args, {
    cwd: options.cwd,
    env: (options.env as NodeJS.ProcessEnv) ?? process.env,
    stdio: [
      target(options.stdin ?? "ignore"),
      target(options.stdout ?? "pipe"),
      target(options.stderr ?? "pipe"),
    ],
  });
  const stdout = collect(child.stdout ?? null);
  const stderr = collect(child.stderr ?? null);
  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      const exitCode = code ?? 1;
      for (const fd of [options.stdout, options.stderr])
        if (typeof fd === "number") closeSync(fd);
      options.onExit?.(exitCode);
      resolve(exitCode);
    });
    child.on("error", () => resolve(1));
  });
  return Object.assign(child, {
    exited,
    text: () => stdout,
    stdout,
    stderr,
    kill: (signal?: string) => child.kill(signal as NodeJS.Signals),
    ref: () => child.ref(),
    unref: () => child.unref(),
  });
}

async function writeValue(value: unknown): Promise<string | Buffer> {
  if (value instanceof NodeBunFile) return value.textSync();
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value && typeof (value as Any).arrayBuffer === "function") {
    return Buffer.from(await (value as Any).arrayBuffer());
  }
  if (value && typeof (value as Any).text === "function")
    return (value as Any).text();
  return JSON.stringify(value);
}

function writeFile(
  destination: string | NodeBunFile,
  value: unknown,
): Promise<number> {
  const path =
    destination instanceof NodeBunFile ? destination.__bunPath : destination;
  return writeValue(value).then((data) => {
    mkdirSync(dirname(path), { recursive: true });
    if (typeof data === "string") writeFileSync(path, data, "utf8");
    else writeFileSync(path, data);
    return Buffer.byteLength(data);
  });
}

/** A Bun.serve-shaped fetch handler over node:http, enough for the suites that stand up a fake provider. */
function serve(options: {
  hostname?: string;
  port?: number;
  fetch: (request: Request, server: Any) => Response | Promise<Response>;
}): Any {
  const server = http.createServer((req, res) => {
    const body = Readable.toWeb(
      createReadStreamStub(req),
    ) as unknown as ReadableStream;
    const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      duplex: "half",
    } as RequestInit);
    Promise.resolve(options.fetch(request as Request, api))
      .then((response) => {
        res.writeHead(
          response.status,
          Object.fromEntries(response.headers.entries()),
        );
        return response.body
          ? response.arrayBuffer().then((buffer) => Buffer.from(buffer))
          : Buffer.alloc(0);
      })
      .then((payload) => res.end(payload))
      .catch((error) => {
        res.writeHead(500).end(String((error as Error).message));
      });
  });
  const port = options.port ?? 0;
  server.listen(port, options.hostname ?? "127.0.0.1");
  const api = {
    fetch,
    port,
    hostname: options.hostname ?? "127.0.0.1",
    get url() {
      const address = server.address();
      const actual =
        typeof address === "object" && address ? address.port : port;
      return `http://${options.hostname ?? "127.0.0.1"}:${actual}`;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return Object.assign(api, {
    server,
    reload: () => undefined,
  });
}

function createReadStreamStub(req: http.IncomingMessage): Readable {
  return req;
}

export const Bun: Any = {
  argv: [bunBinary(), ...process.argv.slice(1)],
  env: process.env,
  version: process.versions.node,
  file: (path: string) => new NodeBunFile(path),
  write: writeFile,
  spawn: (command: readonly string[], options?: SpawnOptions) =>
    run(command, options),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  which: (name: string) => whichBun(name),
  exist: (path: string) => existsSync(path),
  rm: (path: string, options?: { recursive?: boolean; force?: boolean }) =>
    rmSync(path, {
      recursive: options?.recursive ?? false,
      force: options?.force ?? true,
    }),
  mkdir: (path: string, options?: { recursive?: boolean }) =>
    mkdirSync(path, { recursive: options?.recursive ?? false }),
  read: (path: string) => readFileSync(path),
  CryptoHasher: class {
    private inner: Any;
    constructor(algorithm: string) {
      this.inner = createHash(algorithm);
    }
    update(value: string | Uint8Array) {
      this.inner.update(value);
      return this;
    }
    digest(encoding?: string) {
      return this.inner.digest(encoding as Any);
    }
  },
  serve,
};

export { serve };

if (!("Bun" in globalThis)) {
  (globalThis as Any).Bun = Bun;
}
