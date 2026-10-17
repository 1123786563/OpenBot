import { describe, expect, test } from "bun:test";
import {
  createInProcessShareLimiter,
  createShareService,
  hashShareToken,
  newShareToken,
  type ShareStore,
} from "../src/workshop/sharing";

/**
 * The share contract: entropy, one-time plaintext, the uniform miss, the HMAC'd artifact
 * links, and the rate door. The store is a map; nothing here touches a database or a network.
 */
function fakeStore(
  seed: {
    hash: string;
    channelId?: string;
    scope?: "preview" | "preview_download";
    expiresAt?: Date | null;
    revokedAt?: Date | null;
  } | null = null,
) {
  let saved: {
    tokenHash: string;
    channelId: string;
    scope: "preview" | "preview_download";
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdBy: string;
  } | null =
    seed === null
      ? null
      : {
          tokenHash: seed.hash,
          channelId: seed.channelId ?? "ch_1",
          scope: seed.scope ?? "preview",
          expiresAt: seed.expiresAt ?? null,
          revokedAt: seed.revokedAt ?? null,
          createdBy: "seeder",
        };
  const store: ShareStore = {
    setShare: async (input) => {
      saved = { ...input, revokedAt: null };
    },
    revokeShare: async () => {
      if (saved) saved.revokedAt = new Date();
    },
    findLiveShareByTokenHash: async (tokenHash) =>
      saved && saved.tokenHash === tokenHash
        ? {
            channelId: saved.channelId,
            botId: "bot_1",
            scope: saved.scope,
            expiresAt: saved.expiresAt,
            revokedAt: saved.revokedAt,
          }
        : undefined,
  };
  return { store, savedRef: () => saved };
}

const SERVICE = (store: ShareStore, now = new Date()) =>
  createShareService({
    store,
    signingKey: "test-signing-key",
    now: () => now,
  });

describe("workshop shares (B14)", () => {
  test("a created share stores the hash, never the plaintext; the handle carries it once", async () => {
    const { store, savedRef } = fakeStore();
    const handle = await SERVICE(store).createShare({
      channelId: "ch_1",
      scope: "preview",
      createdBy: "user_1",
    });
    expect(handle.token.length).toBeGreaterThanOrEqual(32);
    expect(savedRef()?.tokenHash).toBe(hashShareToken(handle.token));
    expect(savedRef()?.tokenHash).not.toBe(handle.token);
    expect(handle.shareUrl).toContain(`t=${handle.token}`);
    // And the actor resolves: token → scoped actor.
    await expect(
      SERVICE(store).resolveShareActor(handle.token),
    ).resolves.toMatchObject({
      channelId: "ch_1",
      botId: "bot_1",
      scope: "preview",
    });
  });

  test("a wrong token, an expired link, and a revoked one answer the SAME null", async () => {
    const token = newShareToken();
    const hash = hashShareToken(token);
    // Wrong token: no row at all.
    const empty = fakeStore(null);
    await expect(
      SERVICE(empty.store).resolveShareActor(token),
    ).resolves.toBeNull();
    // Expired: row exists, expiry passed.
    const expired = fakeStore({
      hash,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    await expect(
      SERVICE(
        expired.store,
        new Date("2026-06-01T00:00:00Z"),
      ).resolveShareActor(token),
    ).resolves.toBeNull();
    // Revoked: row exists, revokedAt set.
    const revoked = fakeStore({
      hash,
      revokedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await expect(
      SERVICE(revoked.store).resolveShareActor(token),
    ).resolves.toBeNull();
  });

  test("revoke keeps working links dead (and a fresh token replaces the old)", async () => {
    const { store } = fakeStore();
    const service = SERVICE(store);
    const first = await service.createShare({
      channelId: "ch_1",
      scope: "preview",
      createdBy: "u",
    });
    await service.revokeShare("ch_1");
    await expect(service.resolveShareActor(first.token)).resolves.toBeNull();
    const second = await service.createShare({
      channelId: "ch_1",
      scope: "preview_download",
      createdBy: "u",
    });
    await expect(
      service.resolveShareActor(second.token),
    ).resolves.toMatchObject({ scope: "preview_download" });
  });

  test("artifact URLs are HMAC-signed, and any reshape fails verification", async () => {
    const { store } = fakeStore();
    const service = SERVICE(store);
    const url = service.signArtifactUrl({
      channelId: "ch_1",
      artifactId: "wa_1",
      scope: "preview_download",
    });
    const signature = new URL(`http://x${url}`).searchParams.get("s") ?? "";
    expect(
      service.verifyArtifactUrl("ch_1", "wa_1", "preview_download", signature),
    ).toBe(true);
    // A different artifact, a different scope, a different channel: all fail.
    expect(
      service.verifyArtifactUrl("ch_1", "wa_2", "preview_download", signature),
    ).toBe(false);
    expect(
      service.verifyArtifactUrl("ch_1", "wa_1", "preview", signature),
    ).toBe(false);
    expect(
      service.verifyArtifactUrl("ch_2", "wa_1", "preview_download", signature),
    ).toBe(false);
    // A mangled signature fails without throwing.
    expect(
      service.verifyArtifactUrl(
        "ch_1",
        "wa_1",
        "preview_download",
        signature.slice(0, -2) + "x=",
      ),
    ).toBe(false);
  });

  test("the in-process limiter: under the budget true, past it false, window rollover resets", async () => {
    let clock = 0;
    const limiter = createInProcessShareLimiter(3, () => clock);
    const key = hashShareToken(newShareToken());
    expect(await limiter.hit(key)).toBe(true);
    expect(await limiter.hit(key)).toBe(true);
    expect(await limiter.hit(key)).toBe(true);
    expect(await limiter.hit(key)).toBe(false); // Past 3 in this minute.
    clock += 61_000;
    expect(await limiter.hit(key)).toBe(true); // The window rolled.
  });

  test("the service's rate door is keyed on the token's hash, never its plaintext", async () => {
    const { store } = fakeStore();
    const seen: string[] = [];
    const service = createShareService({
      store,
      signingKey: "k",
      limiter: {
        hit: async (key) => {
          seen.push(key);
          return true;
        },
      },
    });
    const token = newShareToken();
    await service.underRateLimit(token);
    expect(seen[0]).toBe(hashShareToken(token)); // The limiter's key is the hash...
    expect(seen[0]).not.toBe(token); // ...and the plaintext never reached it.
    expect(seen[0]).toHaveLength(64); // sha256 hex, on its face.
  });
});
