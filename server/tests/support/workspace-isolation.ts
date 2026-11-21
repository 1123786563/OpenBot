import { expect } from "bun:test";

type OwnerIndex = 0 | 1;

type IsolationProbe = {
  request: (viewer: OwnerIndex, resourceOwner: OwnerIndex) => Promise<Response>;
} & (
  | { state: "closed" }
  | {
      state: "enabled";
      assertOwned: (response: Response, owner: OwnerIndex) => Promise<void>;
      missing: (viewer: OwnerIndex) => Promise<Response>;
    }
);

export async function assertWorkspaceIsolation(probe: IsolationProbe) {
  for (const [viewer, other] of [
    [0, 1],
    [1, 0],
  ] as const) {
    const own = await probe.request(viewer, viewer);
    const crossed = await probe.request(viewer, other);
    expect(own.headers.get("cache-control")).toBe("no-store");
    expect(crossed.headers.get("cache-control")).toBe("no-store");
    expect(crossed.status).toBe(404);
    if (probe.state === "closed") {
      expect(own.status).toBe(404);
      expect(await crossed.text()).toBe(await own.text());
    } else {
      await probe.assertOwned(own, viewer);
      const missing = await probe.missing(viewer);
      expect(missing.status).toBe(404);
      expect(await crossed.text()).toBe(await missing.text());
    }
  }
}
