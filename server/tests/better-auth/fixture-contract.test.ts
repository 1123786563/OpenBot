import { expect, test } from "../../../tests/support/bun-test-compat";
import { createBaFixture } from "./support/fixture";

/*
 * The contract every better-auth DB suite inherits from the fixture (T01.02,
 * acceptance V-B): five isolated role URLs on one loopback openbot_enterprise_*
 * database, a real HTTP request plane, and a teardown that leaves nothing of
 * the fixture's behind.
 */
test("real_fixture_http_uses_isolated_database_and_cleans_own_resources", {
  timeout: 180_000,
}, async () => {
  const fixture = await createBaFixture();
  try {
    // Isolation: every restricted dial lands as its capability role, and the
    // auth-writer pair carries the named session identity.
    const roles = await fixture.roles();
    expect(roles.map((role) => role.actualRole).sort()).toEqual([
      "ob_ent_auth_writer",
      "ob_ent_data",
      "ob_ent_directory",
      "ob_ent_operator",
    ]);
    const writer = roles.find(
      (role) => role.capability === "ob_ent_auth_writer",
    );
    expect(writer?.actualRole).toBe("ob_ent_auth_writer");
    expect(writer?.sessionUser).toBe("ent_ba_auth_writer");

    // Real HTTP: an actual loopback server, a real fetch, and a write that
    // lands in the isolated database through the auth-writer capability.
    const created = await fixture.request("/ba-fixture/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "T01.02 fixture contract" }),
    });
    expect(created.status).toBe(201);
    const who = (await (
      await fixture.request("/ba-fixture/whoami")
    ).json()) as {
      role: string;
    };
    expect(who.role).toBe("ob_ent_auth_writer");

    expect(await fixture.snapshot()).toEqual({ markers: 0, notes: 1 });

    // Fault injection fails the handler without stranding the fixture's
    // resources or corrupting the snapshot.
    fixture.injectFault("handler");
    const failed = await fixture.request("/ba-fixture/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "must not land" }),
    });
    expect(failed.status).toBe(500);
    expect(await fixture.snapshot()).toEqual({ markers: 0, notes: 1 });
    fixture.injectFault("none");
  } finally {
    // Cleanup runs even when an assertion above fails: the leak check below
    // must see the fixture's own resources gone, not a half-torn state.
    await fixture.close();
  }
  expect(await fixture.leakedResources()).toEqual([]);
});
