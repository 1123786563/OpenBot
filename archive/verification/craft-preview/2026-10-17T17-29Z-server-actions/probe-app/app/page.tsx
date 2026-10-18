"use client";

import { useEffect, useState } from "react";
import { ping, stamp, go, boom } from "./actions";

const PROBES = [
  ["ping", ping],
  ["stamp", stamp],
  ["boom", boom],
] as const;

export default function ProbePage() {
  const [out, setOut] = useState<Record<string, string>>({});
  const [hydrated, setHydrated] = useState(false);
  const [jar, setJar] = useState("ssr");

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    setJar(document.cookie || "empty");
  }, [out, hydrated]);

  async function run(name: string, fn: () => Promise<unknown>) {
    setOut((p) => ({ ...p, [name]: "pending" }));
    try {
      const r = await fn();
      setOut((p) => ({ ...p, [name]: `OK:${String(r)}` }));
    } catch (error) {
      const msg =
        error instanceof Error
          ? `${error.name}:${error.message.slice(0, 200)}`
          : String(error).slice(0, 200);
      setOut((p) => ({ ...p, [name]: `ERR:${msg}` }));
    }
  }

  return (
    <main
      style={{
        fontFamily: "system-ui",
        padding: 24,
        display: "grid",
        gap: 8,
      }}
    >
      <h1>#414 server-action probe</h1>
      <p data-testid="probe-hydrated">{String(hydrated)}</p>
      <p data-testid="probe-base">{process.env.NEXT_PUBLIC_BASE_PATH || "/"}</p>
      {PROBES.map(([name, fn]) => (
        <div key={name}>
          <button
            type="button"
            data-testid={`run-${name}`}
            onClick={() => void run(name, fn as () => Promise<unknown>)}
          >
            {name}
          </button>
          <span data-testid={`result-${name}`}>{out[name] ?? "idle"}</span>
        </div>
      ))}
      <button
        type="button"
        data-testid="run-go"
        onClick={() => void run("go", go as () => Promise<unknown>)}
      >
        go
      </button>
      <span data-testid="result-go">{out.go ?? "idle"}</span>
      <p data-testid="probe-cookie">{jar}</p>
    </main>
  );
}
