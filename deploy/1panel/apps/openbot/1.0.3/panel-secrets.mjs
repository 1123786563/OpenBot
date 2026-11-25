import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const path = "/panel-secrets/keys.json";
const [mode, ...args] = process.argv.slice(2);

if (mode === "init") {
  const keys = Object.fromEntries(
    args.map((entry) => {
      const [name, bytes, encoding] = entry.split(":");
      return [
        name,
        process.env[name] || randomBytes(Number(bytes)).toString(encoding),
      ];
    }),
  );
  const temporary = `${path}.${randomBytes(8).toString("hex")}`;
  writeFileSync(temporary, JSON.stringify(keys), { mode: 0o444, flag: "wx" });
  try {
    linkSync(temporary, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
  const saved = JSON.parse(readFileSync(path, "utf8"));
  for (const name of Object.keys(keys)) {
    if (
      !saved[name] ||
      (process.env[name] && process.env[name] !== saved[name])
    ) {
      throw new Error(`Restore the original value for ${name}`);
    }
  }
} else {
  const keys = JSON.parse(readFileSync(path, "utf8"));
  const [command, ...parameters] = args;
  for (const name of Object.keys(process.env)) {
    if (process.env[name] === "") delete process.env[name];
  }
  const child = spawn(command, parameters, {
    env: { ...process.env, ...keys },
    stdio: "inherit",
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
