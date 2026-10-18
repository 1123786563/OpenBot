"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

const WATCH = [
  "origin",
  "host",
  "x-forwarded-host",
  "x-forwarded-proto",
  "next-action",
  "sec-fetch-site",
  "sec-fetch-mode",
  "referer",
];

async function echo(): Promise<Record<string, string>> {
  const h = await headers();
  const out: Record<string, string> = {};
  for (const k of WATCH) out[k] = h.get(k) ?? "ABSENT";
  out.cookie_names = h
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim().split("=")[0])
    .join(",") ?? "NONE";
  return out;
}

export async function ping(): Promise<string> {
  return `action-ok-${JSON.stringify(await echo())}`;
}

export async function stamp(): Promise<string> {
  const jar = await cookies();
  jar.set("probe_host_only", "stamp-1", { path: "/", sameSite: "lax" });
  return `cookie-set-${JSON.stringify(await echo())}`;
}

export async function go(): Promise<string> {
  redirect("/done");
}

export async function boom(): Promise<string> {
  throw new Error("probe-action-failed");
}
