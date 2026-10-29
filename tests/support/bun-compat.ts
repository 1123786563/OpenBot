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
import { readdir } from "node:fs/promises";
import http from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import YAML from "yaml";

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
  /** Bun's is a method returning a promise, not a property: `await Bun.file(p).exists()`. */
  exists(): Promise<boolean> {
    return Promise.resolve(existsSync(this.__bunPath));
  }
  existsSync(): boolean {
    return existsSync(this.__bunPath);
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
    return this.bytes().then(
      (value) =>
        value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        ) as ArrayBuffer,
    );
  }
  json(): Promise<Any> {
    return this.text().then((value) => JSON.parse(value));
  }
  stream(): Readable {
    return createReadStream(this.__bunPath);
  }
}

/**
 * `Bun.Glob(pattern).scan(dir)` walks a directory for the pattern. Only the forms the suites use
 * are supported: `**` across directories, `*` within one name, and a trailing extension.
 */
export class Glob {
  readonly pattern: string;
  private matcher: RegExp;
  constructor(pattern: string) {
    this.pattern = pattern;
    // `**` may cross directories and also match none, `*` stops at a separator.
    const source = pattern
      .split("**")
      .map((part) =>
        part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
      )
      .join("(?:.*/)?");
    this.matcher = new RegExp(`^${source}$`);
  }
  async *scan(root: string): AsyncGenerator<string> {
    const walk = async function* (dir: string): AsyncGenerator<string> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield full;
      }
    };
    const base = resolve(root);
    for await (const path of walk(base)) {
      if (this.matcher.test(path.replace(`${base}/`, ""))) yield path;
    }
  }
  match(path: string, cwd = "."): boolean {
    return this.matcher.test(
      isAbsolute(path) ? path.replace(`${resolve(cwd)}/`, "") : path,
    );
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

/**
 * Bun answers a piped child stream as a web `ReadableStream` carrying `text()`/`bytes()`. Suites do
 * `await new Response(child.stdout).text()` and `await child.stdout.text()`, so both forms have to
 * work; a bare promise stringifies to "[object Promise]" and silently corrupts the assertion.
 */
function collect(stream: Readable | null): Any {
  const chunks: Promise<Buffer> = new Promise((resolve, reject) => {
    if (!stream) return resolve(Buffer.alloc(0));
    const parts: Buffer[] = [];
    stream.on("data", (chunk) => parts.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", reject);
  });
  const web = Readable.toWeb((stream ?? Readable.from([])) as Readable) as Any;
  web.text = () => chunks.then((value: Buffer) => value.toString("utf8"));
  web.bytes = () => chunks.then((value: Buffer) => new Uint8Array(value));
  // Node's Buffer satisfies ArrayBufferView<ArrayBuffer> only loosely; the view over it does not lie.
  web.blob = () =>
    chunks.then((value: Buffer) => new Blob([new Uint8Array(value)]));
  web.json = () =>
    web.text().then((value: string) => JSON.parse(value)) as Promise<Any>;
  return web;
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
  // Bound before the assignment below: `Object.assign(child, …)` replaces these very methods on the
  // object they were read from, so a wrapper that calls `child.kill()` calls itself forever.
  const nativeKill = child.kill.bind(child);
  const nativeRef = child.ref.bind(child);
  const nativeUnref = child.unref.bind(child);
  return Object.assign(child, {
    exited,
    text: () => stdout,
    stdout,
    stderr,
    kill: (signal?: string) => nativeKill(signal as NodeJS.Signals),
    ref: () => nativeRef(),
    unref: () => nativeUnref(),
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
        // writeHead's object form joins duplicate headers with ", " — for
        // set-cookie that is one malformed header and the browser keeps only
        // one cookie of the response (a site that sets a session and a
        // persistent cookie lost the session one). Use the flat-array form and
        // hand Node the split list undici already parsed.
        const setCookies =
          typeof response.headers.getSetCookie === "function"
            ? response.headers.getSetCookie()
            : [];
        const flat: string[] = [];
        for (const cookie of setCookies) flat.push("set-cookie", cookie);
        for (const [key, value] of response.headers.entries()) {
          if (key !== "set-cookie") flat.push(key, value);
        }
        res.writeHead(response.status, flat);
        if (!response.body) return res.end();
        // Chunk by chunk, never buffered to the end first: an event-stream reply has no end, so
        // `arrayBuffer()` would sit there until the client's own timeout and the suite would read an
        // empty list of forwarded requests — the request reached the handler, the reply never left.
        const stream = Readable.fromWeb(response.body as Any);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      })
      .catch((error) => {
        res.writeHead(500).end(String((error as Error).message));
      });
  });
  // Node only assigns the ephemeral port on the 'listening' tick, so a suite that reads
  // `.port` on the line after serve() gets 0 and navigates to http://127.0.0.1:0 (Bun binds
  // synchronously, which is why the same suite is green under the real runtime). Choose a
  // concrete port up front instead; the getter below then has the real number immediately.
  // shortcut: a self-picked port can collide with another listener; reserve-then-listen if a suite ever hits EADDRINUSE
  const port =
    (options.port ?? 0) === 0
      ? 20000 + Math.floor(Math.random() * 20000)
      : options.port!;
  server.listen(port, options.hostname ?? "127.0.0.1");
  // A test that forgets `stop()` must not be able to keep the process alive: e2e writes its report
  // and then waits for the worker to exit, so a leaked listener hangs `bun run test` forever after
  // the summary has printed. `unref` lets the loop drain; anything the test is still awaiting keeps
  // the process up on its own, and `stop()` still works because the handle is merely non-blocking.
  server.unref();
  // `port` must be read after the bind: a suite asks for 0 to get an ephemeral port and then builds
  // the URL it will fetch, so a snapshot of the requested value hands back `http://127.0.0.1:0`.
  const boundPort = () => {
    const address = server.address();
    return typeof address === "object" && address ? address.port : port;
  };
  const api = {
    fetch,
    get port() {
      return boundPort();
    },
    hostname: options.hostname ?? "127.0.0.1",
    get url() {
      return `http://${options.hostname ?? "127.0.0.1"}:${boundPort()}`;
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
  Glob,
  exist: (path: string) => existsSync(path),
  rm: (path: string, options?: { recursive?: boolean; force?: boolean }) =>
    rmSync(path, {
      recursive: options?.recursive ?? false,
      force: options?.force ?? true,
    }),
  mkdir: (path: string, options?: { recursive?: boolean }) =>
    mkdirSync(path, { recursive: options?.recursive ?? false }),
  read: (path: string) => readFileSync(path),
  CryptoHasher: Object.assign(
    class {
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
    {
      // `Bun.CryptoHasher.hash("sha256", data)` is the one-call form the suites use.
      hash(algorithm: string, value: string | Uint8Array, encoding?: string) {
        return createHash(algorithm)
          .update(value)
          .digest(encoding as Any);
      },
    },
  ),
  serve,
  // Bun parses YAML natively; the repository already carries `yaml` as a dev dependency.
  YAML: {
    parse: (text: string) => YAML.parse(text),
    stringify: (value: unknown) => YAML.stringify(value),
    Schema: YAML.Schema,
  },
};

export { serve };

if (!("Bun" in globalThis)) {
  (globalThis as Any).Bun = Bun;
}
