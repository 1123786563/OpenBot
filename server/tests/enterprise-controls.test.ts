import {
  afterEach,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import {
  type CapabilityRow,
  DEFAULT_CAPABILITIES,
  resolveCapability,
} from "../src/admin/capabilities";
import { decideFromSnapshot } from "../src/admin/controls";
import { DEFAULT_ENTERPRISE_SETTINGS } from "../src/admin/settings-store";
import { decideSignInMethod } from "../src/auth";
import {
  evaluateActionPolicy,
  type PolicyContext,
  setPolicyOverlay,
} from "../src/computer/policy";
import {
  effectiveNetworkPolicy,
  pushEgressPolicies,
} from "../src/computer/policy-network";
import type { ComputerProvider } from "../src/computer/provider";
import { scrubCommand } from "../src/telemetry/scrub";

const row = (
  scopeKind: CapabilityRow["scopeKind"],
  scopeId: string,
  capability: string,
  allowed: boolean,
): CapabilityRow => ({ scopeKind, scopeId, capability, allowed });

describe("capability resolution", () => {
  const user = { role: "user" as const, groups: [] };

  test("no rows means the built-in default, which keeps today's behaviour", () => {
    expect(resolveCapability([], user, "cloudBrowser")).toMatchObject({
      allowed: true,
      decidedBy: "default",
    });
    expect(resolveCapability([], user, "teamBots").allowed).toBe(
      DEFAULT_CAPABILITIES.teamBots,
    );
  });

  test("organization is the baseline, a role replaces it", () => {
    const rows = [
      row("organization", "", "localComputer", false),
      row("role", "admin", "localComputer", true),
    ];
    expect(resolveCapability(rows, user, "localComputer").allowed).toBe(false);
    expect(
      resolveCapability(rows, { role: "admin", groups: [] }, "localComputer"),
    ).toMatchObject({ allowed: true, decidedBy: "role" });
  });

  test("a group only widens", () => {
    const rows = [
      row("organization", "", "slackTeams", false),
      row("group", "sales", "slackTeams", true),
      row("organization", "", "cloudBrowser", true),
      row("group", "contractors", "cloudBrowser", false),
    ];
    expect(
      resolveCapability(
        rows,
        { role: "user", groups: ["sales"] },
        "slackTeams",
      ),
    ).toMatchObject({ allowed: true, decidedBy: "group", scopeId: "sales" });
    expect(resolveCapability(rows, user, "slackTeams").allowed).toBe(false);
    // A group row of false narrows nothing.
    expect(
      resolveCapability(
        rows,
        { role: "user", groups: ["contractors"] },
        "cloudBrowser",
      ).allowed,
    ).toBe(true);
  });
});

function snapshot(
  overrides: Partial<Parameters<typeof decideFromSnapshot>[0] & object> = {},
) {
  return {
    rows: [],
    admins: new Set<string>(),
    groupsByUser: new Map<string, string[]>(),
    settings: DEFAULT_ENTERPRISE_SETTINGS,
    network: [],
    loadedAt: new Date(),
    ...overrides,
  };
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tool: { name: "computer_navigate" },
    bot: { id: "bot" },
    actor: { id: "person" },
    page: { url: "https://example.com/", host: "example.com" },
    intent: "navigate",
    key: "",
    element: { ref: "", role: "", name: "", type: "" },
    file: { path: "", name: "", extension: "" },
    command: "",
    mcp: { server: "", tool: "", effect: "" },
    initiator: { kind: "person", id: "" },
    ...overrides,
  };
}

describe("the computer boundary overlay", () => {
  afterEach(() => setPolicyOverlay(null));

  test("a snapshot that never loaded refuses (fail closed)", () => {
    expect(decideFromSnapshot(undefined, context())?.forward).toBe(false);
  });

  test("nothing configured says nothing, so the boundary's own rules decide", () => {
    expect(decideFromSnapshot(snapshot(), context())).toBeNull();
  });

  test("browser, network, computer and Bots switches each refuse their actions", () => {
    const off = (capability: string) =>
      snapshot({ rows: [row("organization", "", capability, false)] });
    expect(decideFromSnapshot(off("cloudBrowser"), context())?.matched).toBe(
      "capability:cloudBrowser",
    );
    expect(decideFromSnapshot(off("cloudNetwork"), context())?.matched).toBe(
      "capability:cloudNetwork",
    );
    const shell = context({
      tool: { name: "computer_run_command" },
      intent: "run_command",
      command: "ls",
    });
    expect(decideFromSnapshot(off("cloudComputer"), shell)?.matched).toBe(
      "capability:cloudComputer",
    );
    expect(decideFromSnapshot(off("cloudBrowser"), shell)).toBeNull();
    expect(decideFromSnapshot(off("useBots"), shell)?.matched).toBe(
      "capability:useBots",
    );
  });

  test("the computer switch refuses downloading a workspace file", () => {
    const off = (capability: string) =>
      snapshot({ rows: [row("organization", "", capability, false)] });
    const download = context({
      tool: { name: "computer_download_file" },
      intent: "download_file",
    });
    expect(decideFromSnapshot(off("cloudComputer"), download)?.matched).toBe(
      "capability:cloudComputer",
    );
    expect(decideFromSnapshot(off("cloudBrowser"), download)).toBeNull();
  });

  test("a group grant reaches the snapshot's members", () => {
    const current = snapshot({
      rows: [
        row("organization", "", "cloudBrowser", false),
        row("group", "eng", "cloudBrowser", true),
      ],
      groupsByUser: new Map([["person", ["eng"]]]),
    });
    expect(decideFromSnapshot(current, context())).toBeNull();
    expect(
      decideFromSnapshot(current, context({ actor: { id: "other" } }))?.forward,
    ).toBe(false);
  });

  test("the MCP allowlist refuses servers not on it", () => {
    const current = snapshot({
      settings: {
        ...DEFAULT_ENTERPRISE_SETTINGS,
        mcpAllowlist: { enabled: true, servers: ["jira"] },
      },
    });
    const call = (server: string) =>
      context({
        tool: { name: `${server}__search` },
        intent: "read_tool",
        page: { url: "", host: "" },
        mcp: { server, tool: "search", effect: "read" },
      });
    expect(decideFromSnapshot(current, call("jira"))).toBeNull();
    expect(decideFromSnapshot(current, call("shadow-mcp"))?.matched).toBe(
      "mcp_allowlist",
    );
  });

  test("a navigation off the allowlist is refused before it reaches the computer", () => {
    const current = snapshot({
      network: [
        {
          scopeKind: "organization",
          scopeId: "",
          mode: "allowlist_only",
          rules: [{ type: "domain", value: "example.com" }],
          locked: false,
          updatedBy: null,
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    expect(decideFromSnapshot(current, context())).toBeNull();
    expect(
      decideFromSnapshot(
        current,
        context({ page: { url: "https://evil.test/", host: "evil.test" } }),
      )?.matched,
    ).toBe("network:organization");
  });

  test("installed, it is final even over a permissive dry-run boundary", () => {
    const current = snapshot({
      rows: [row("organization", "", "cloudBrowser", false)],
    });
    setPolicyOverlay((ctx) => decideFromSnapshot(current, ctx));
    const decision = evaluateActionPolicy(
      { mode: "dry-run", deny: [], allow: ["true"] },
      context(),
    );
    expect(decision).toMatchObject({ allowed: false, forward: false });
  });

  test("an overlay that throws refuses", () => {
    setPolicyOverlay(() => {
      throw new Error("boom");
    });
    expect(
      evaluateActionPolicy(
        { mode: "enforce", deny: [], allow: ["true"] },
        context(),
      ).forward,
    ).toBe(false);
  });
});

describe("network policy selection", () => {
  const organization = {
    scopeKind: "organization" as const,
    scopeId: "",
    mode: "allowlist_only" as const,
    rules: [{ type: "domain", value: "example.com" }],
    locked: false,
    updatedBy: null,
    updatedAt: "",
  };
  const group = {
    ...organization,
    scopeKind: "group" as const,
    scopeId: "research",
    mode: "allow_all" as const,
    rules: [],
  };

  test("a group policy replaces the organization's, unless it is locked", () => {
    expect(
      effectiveNetworkPolicy(
        [organization, group],
        { groups: ["research"] },
        true,
      ),
    ).toMatchObject({ mode: "allow_all", from: "group:research" });
    expect(
      effectiveNetworkPolicy(
        [{ ...organization, locked: true }, group],
        { groups: ["research"] },
        true,
      ),
    ).toMatchObject({ mode: "allowlist_only", from: "organization" });
  });

  test("no network capability is deny_all whatever the policy says", () => {
    expect(
      effectiveNetworkPolicy([group], { groups: ["research"] }, false).mode,
    ).toBe("deny_all");
  });

  test("the push goes to running computers only, never waking one", async () => {
    const sent: { url: string; body: string; bot: string | null }[] = [];
    const provider = {
      list: async () => [
        { botId: "a", status: "running", url: "http://10.0.0.1:4100" },
        { botId: "b", status: "stopped", url: "http://10.0.0.2:4100" },
      ],
    } as unknown as ComputerProvider;
    const report = await pushEgressPolicies({
      provider,
      token: "t",
      policyForBot: async () => ({ mode: "deny_all", rules: [] }),
      fetchImpl: (async (url: string, init: RequestInit) => {
        sent.push({
          url,
          body: String(init.body),
          bot: new Headers(init.headers).get("x-openbot-bot-id"),
        });
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    expect(report.pushed).toEqual(["a"]);
    expect(sent).toEqual([
      {
        url: "http://10.0.0.1:4100/egress-policy",
        body: JSON.stringify({ policy: { mode: "deny_all", rules: [] } }),
        bot: "a",
      },
    ]);
  });
});

describe("SSO required", () => {
  const decide = (method: string, email: string, required: boolean) =>
    decideSignInMethod({
      method,
      email,
      ssoRequired: async () => required,
      initialAdminEmails: ["root@acme.test"],
    });

  test("off admits everybody, on admits only an enterprise provider", async () => {
    expect(await decide("oauth", "a@acme.test", false)).toBe("allow");
    expect(await decide("oauth", "a@acme.test", true)).toBe("refuse");
    expect(await decide("email-password", "a@acme.test", true)).toBe("refuse");
    expect(await decide("sso-saml", "a@acme.test", true)).toBe("allow");
    expect(await decide("sso-oidc", "a@acme.test", true)).toBe("allow");
  });

  test("a configured administrator is let in as break-glass", async () => {
    expect(await decide("oauth", "ROOT@acme.test", true)).toBe("break_glass");
  });

  test("settings that cannot be read refuse", async () => {
    expect(
      await decideSignInMethod({
        method: "oauth",
        email: "a@acme.test",
        ssoRequired: async () => {
          throw new Error("database down");
        },
        initialAdminEmails: [],
      }),
    ).toBe("refuse");
  });
});

describe("scrubbing commands", () => {
  const cases: [string, string][] = [
    [
      "curl -H 'Authorization: Bearer abc.def' https://api.example.com",
      "curl -H 'Authorization: Bearer [REDACTED]' https://api.example.com",
    ],
    [
      "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "export GITHUB_TOKEN=[REDACTED]",
    ],
    [
      "psql postgres://app:hunter2@db:5432/app",
      "psql postgres://app:[REDACTED]@db:5432/app",
    ],
    ["mysql -uroot -phunter2 app", "mysql -uroot -p[REDACTED] app"],
    [
      "tool --password hunter2 --verbose",
      "tool --password [REDACTED] --verbose",
    ],
    [
      "AWS_SECRET_ACCESS_KEY=abc123 aws s3 ls",
      "AWS_SECRET_ACCESS_KEY=[REDACTED] aws s3 ls",
    ],
    [
      "curl -u admin:s3cret https://x.test",
      "curl -u admin:[REDACTED] https://x.test",
    ],
    ["echo sk-proj-abcdefghijklmnopqrstuvwxyz", "echo [REDACTED]"],
    [
      `curl -d '{"user":"ann","password":"hunter2"}' https://x.test`,
      `curl -d '{"user":"ann","password":[REDACTED]}' https://x.test`,
    ],
    [
      `curl -d '{"api_key": "abcd1234", "n": 1}' https://x.test`,
      `curl -d '{"api_key": [REDACTED], "n": 1}' https://x.test`,
    ],
    [
      'curl -d "{\\"client_secret\\":\\"hunter2\\"}" https://x.test',
      'curl -d "{\\"client_secret\\":[REDACTED]}" https://x.test',
    ],
    [
      "curl -uadmin:s3cret https://x.test",
      "curl -uadmin:[REDACTED] https://x.test",
    ],
    [
      "curl --user=admin:s3cret https://x.test",
      "curl --user=admin:[REDACTED] https://x.test",
    ],
    [
      'curl -u "admin:s3 cret" https://x.test',
      "curl -u admin:[REDACTED] https://x.test",
    ],
    [
      "curl --proxy-user admin:glorbwibble https://x.test",
      "curl --proxy-user admin:[REDACTED] https://x.test",
    ],
    [
      "curl --proxy-user=admin:glorbwibble https://x.test",
      "curl --proxy-user=admin:[REDACTED] https://x.test",
    ],
    // Positional password flags: the word after the flag is the secret, so it takes the tool that
    // owns the flag to say so. The fixture secrets are made-up words that match no token shape.
    [
      "docker login -p glorbwibble registry.example.test",
      "docker login -p [REDACTED] registry.example.test",
    ],
    [
      'docker login -p "glorb wibble" registry.example.test',
      "docker login -p [REDACTED] registry.example.test",
    ],
    [
      "sshpass -p glorbwibble ssh deploy@host.example.test",
      "sshpass -p [REDACTED] ssh deploy@host.example.test",
    ],
    [
      "sshpass -p 'glorb wibble' ssh deploy@host.example.test",
      "sshpass -p [REDACTED] ssh deploy@host.example.test",
    ],
    [
      "sshpass -P authprompt -p glorbwibble ssh deploy@host.example.test",
      "sshpass -P authprompt -p [REDACTED] ssh deploy@host.example.test",
    ],
    // An attached password that itself contains a `p` (F04-6): the cluster before the
    // terminator's `p` must not read back into the password, or the password leaks whole and the
    // word after it is redacted in its place. A password that is exactly `p` is the next word.
    [
      "sshpass -phunter2p ssh deploy@host.example.test",
      "sshpass -p[REDACTED] ssh deploy@host.example.test",
    ],
    [
      "sshpass -papple ssh host.example.test",
      "sshpass -p[REDACTED] ssh host.example.test",
    ],
    [
      "sshpass -pp ssh deploy@host.example.test",
      "sshpass -p[REDACTED] ssh deploy@host.example.test",
    ],
    // Shapes that keep working through that fix: a getopt cluster folds `-v` into the password
    // flag; `-P` takes a prompt and `-f` a file, each with the word after it; none is a password.
    [
      "sshpass -vp hunter2 ssh deploy@host.example.test",
      "sshpass -vp [REDACTED] ssh deploy@host.example.test",
    ],
    [
      "sshpass -Pprompt -p glorbwibble ssh deploy@host.example.test",
      "sshpass -Pprompt -p [REDACTED] ssh deploy@host.example.test",
    ],
    [
      "sshpass -f id_rsa -p glorbwibble ssh deploy@host.example.test",
      "sshpass -f id_rsa -p [REDACTED] ssh deploy@host.example.test",
    ],
    // The env form sshpass itself recommends over `-p`: the password is in the assignment, `-e`
    // carries no value of its own, and SSHPASS names no full word the NAME=value rules match.
    [
      "SSHPASS=glorbwibble sshpass -e ssh deploy@host.example.test",
      "SSHPASS=[REDACTED] sshpass -e ssh deploy@host.example.test",
    ],
    [
      "SSHPASS='glorb wibble' sshpass -e ssh deploy@host.example.test",
      "SSHPASS=[REDACTED] sshpass -e ssh deploy@host.example.test",
    ],
    // docker's grammar puts global options between the command and its subcommand; a registry
    // password behind them is still a password.
    [
      "docker -H tcp://registry.example:2375 login -p glorbwibble",
      "docker -H tcp://registry.example:2375 login -p [REDACTED]",
    ],
    [
      "docker --context prod login -p glorbwibble",
      "docker --context prod login -p [REDACTED]",
    ],
    ["redis-cli -a glorbwibble ping", "redis-cli -a [REDACTED] ping"],
    ["redis-cli -aglorbwibble ping", "redis-cli -a[REDACTED] ping"],
    ["redis-cli --pass glorbwibble ping", "redis-cli --pass [REDACTED] ping"],
    ["redis-cli --pass=glorbwibble ping", "redis-cli --pass=[REDACTED] ping"],
    // An attached short form that reads as a flag named after a secret: the password itself goes,
    // and the word after it stays.
    ["redis-cli -aMY_TOKEN_VALUE ping", "redis-cli -a[REDACTED] ping"],
    ["mysqldump -pglorbwibble appdb", "mysqldump -p[REDACTED] appdb"],
    // An uppercase -P is the attached port, not the password: only the lowercase flag reads as one.
    ["mysql -h db -P3306 -phunter2 app", "mysql -h db -P3306 -p[REDACTED] app"],
    // A quoted word in the lead may itself hold an escaped quote (T14): the quoted arm used to close
    // at the escape's `"`, and the dangling quote then left the scan unable to reach the flag, so
    // the password survived whole. The double-quote arm consumes `\"` as a pair; shell single
    // quotes have no escapes, so that arm is unchanged.
    [
      'docker login -u "dev\\"ops" -p hunter2 registry.example.test',
      'docker login -u "dev\\"ops" -p [REDACTED] registry.example.test',
    ],
    [
      'mysqldump -u "a\\"b" -pglorbwibble appdb',
      'mysqldump -u "a\\"b" -p[REDACTED] appdb',
    ],
    [
      'redis-cli -u "a\\"b" -a hunter2 ping',
      'redis-cli -u "a\\"b" -a [REDACTED] ping',
    ],
    // sshpass's own option values sit inside the lead too (`-f`'s file, `-P`'s prompt): a quoted
    // one with an escaped quote is the same arm with the same defect.
    [
      'sshpass -f "id\\"rsa" -p hunter2 ssh deploy@host.example.test',
      'sshpass -f "id\\"rsa" -p [REDACTED] ssh deploy@host.example.test',
    ],
    // A quoted word in the lead may also hold a `;` outright, and may span a line the shell
    // continues (`\` + line break keeps it one command). Both reach the flag through the same
    // quoted arm (R10-C7 guards): the fallback for a quote with no pair must not fire while a
    // closing quote is still reachable — through the continuation too — or these would lose their
    // pairing and the scan its way to the flag.
    [
      'mysql -e "SELECT 1;" -phunter2 app',
      'mysql -e "SELECT 1;" -p[REDACTED] app',
    ],
    ['mysql -u "a\\\nb" -phunter2 app', 'mysql -u "a\\\nb" -p[REDACTED] app'],
    // An unclosed quote in the lead falls back to reading the quote as an ordinary character
    // (R8-C5): a paired quote is still swallowed whole, but a lone apostrophe in a user's name
    // must not leave the scan dead short of the flag — the password behind the stalled scan used
    // to survive whole.
    ["mysql -u o'brien -phunter2 app", "mysql -u o'brien -p[REDACTED] app"],
    [
      'docker login -u a"b -p hunter2 registry.example.test',
      'docker login -u a"b -p [REDACTED] registry.example.test',
    ],
    [
      "redis-cli -u o'brien -a hunter2 ping",
      "redis-cli -u o'brien -a [REDACTED] ping",
    ],
    // A quote segment inside the value is part of the word (R8-C5): the value reads as a run of
    // bare characters and paired quote segments, so `a"b;c"` — a single argv word in the shell —
    // is redacted whole instead of ending at the `;` inside the quotes. The same arm sits in
    // every positional rule: mysql's attached form, sshpass's own options, SSHPASS=, redis-cli.
    [
      'docker login -p a"b;c" registry.example.test',
      "docker login -p [REDACTED] registry.example.test",
    ],
    ["mysql -h db -pa'b;c' app", "mysql -h db -p[REDACTED] app"],
    [
      'sshpass -p a"b;c" ssh deploy@host.example.test',
      "sshpass -p [REDACTED] ssh deploy@host.example.test",
    ],
    [
      'sshpass -f a"b;c" -p hunter2 ssh deploy@host.example.test',
      'sshpass -f a"b;c" -p [REDACTED] ssh deploy@host.example.test',
    ],
    [
      'SSHPASS=a"b;c" sshpass -e ssh deploy@host.example.test',
      "SSHPASS=[REDACTED] sshpass -e ssh deploy@host.example.test",
    ],
    ['redis-cli -a a"b;c" ping', "redis-cli -a [REDACTED] ping"],
    // An unclosed quote inside the value is read as an ordinary character too: the word keeps
    // going past it and still ends at the next unquoted separator.
    [
      'docker login -p a"b;c registry.example.test',
      "docker login -p [REDACTED];c registry.example.test",
    ],
    [
      "docker login -p a'b registry.example.test",
      "docker login -p [REDACTED] registry.example.test",
    ],
    // A bare value ends where its command does (F04-4): in the shell's reading `;`, `|` and `&`
    // start another command, so the redaction must not swallow what follows them.
    ["docker login -p glorbwibble;whoami", "docker login -p [REDACTED];whoami"],
    ["mysql -ppw|tee log", "mysql -p[REDACTED]|tee log"],
    ["redis-cli -a glorbwibble&&ls", "redis-cli -a [REDACTED]&&ls"],
    [
      "sshpass -p glorbwibble;whoami ssh host.example.test",
      "sshpass -p [REDACTED];whoami ssh host.example.test",
    ],
    // The SSHPASS= env form's bare arm shares the root cause and gets the same fix.
    [
      "SSHPASS=glorbwibble;whoami sshpass -e ssh deploy@host.example.test",
      "SSHPASS=[REDACTED];whoami sshpass -e ssh deploy@host.example.test",
    ],
    // An escaped separator belongs to the word, not the shell (R10-C7): in `pa\;ss` the backslash
    // takes the `;` out of the shell's reading, so the whole word is the secret — ending the value
    // at the backslash left the rest of the password in the record. The value arm consumes
    // backslash pairs; the word still ends at an unescaped separator, so `&cmd` after `pa\;` is
    // the next command and stays.
    [
      "docker login -p pa\\;ss registry.example.test",
      "docker login -p [REDACTED] registry.example.test",
    ],
    ["mysql -h db -ppa\\|ss app", "mysql -h db -p[REDACTED] app"],
    [
      "sshpass -p pa\\&ss ssh deploy@host.example.test",
      "sshpass -p [REDACTED] ssh deploy@host.example.test",
    ],
    [
      "SSHPASS=pa\\;&cmd sshpass -e ssh deploy@host.example.test",
      "SSHPASS=[REDACTED]&cmd sshpass -e ssh deploy@host.example.test",
    ],
    ["redis-cli -a pa\\;ss ping", "redis-cli -a [REDACTED] ping"],
    // A value's quote stops at the line break like the lead's does (R10-C7): the shell would not
    // keep a quote that spans a bare line break to one command, so the break ends the value and
    // the next line's command stays in the record — it used to be swallowed whole into the
    // redaction and deleted from the audit trail.
    [
      'docker login -p "oops\necho "hi"',
      'docker login -p [REDACTED]\necho "hi"',
    ],
    // The same fix in the sshpass option loop: `-f`'s file stops at the separator, and the word
    // after it belongs to another command — it is not a password to redact.
    ["sshpass -f pass;ls -p x", "sshpass -f pass;ls -p x"],
    // A separator with no value in front of it (R1-F1): a bare token does not begin with `;`, `|`
    // or `&` — that position starts another command, and an empty value is nothing to redact —
    // so the line survives whole instead of folding the next command into the redaction.
    ["redis-cli -a;whoami", "redis-cli -a;whoami"],
    ["SSHPASS=;cmd sshpass -e ssh h", "SSHPASS=;cmd sshpass -e ssh h"],
    // A separated -p still means the password is prompted for, separators or not: the word after
    // it is a database.
    ["mysql -p pw|tee log", "mysql -p pw|tee log"],
    // Separators inside a quoted password are part of the secret (T8a): the quote, not the `;`,
    // ends the value.
    ['mysql -h db -p"pa;ss" app', "mysql -h db -p[REDACTED] app"],
    [
      "open redis://:glorbwibble@cache:6379/0",
      "open redis://:[REDACTED]@cache:6379/0",
    ],
    // What a flag's own grammar leaves alone: a separated `-p` means the password is prompted for
    // and the word after it is a database; `-U` is not curl's credential flag; a bare `-p` does not
    // swallow the flag that follows it.
    ["mysql -p database", "mysql -p database"],
    ["mysql -uroot -p --verbose", "mysql -uroot -p --verbose"],
    ["docker -p 8080:80 nginx", "docker -p 8080:80 nginx"],
    ["docker login -p -u deploy", "docker login -p -u deploy"],
    [
      "docker login --password-stdin < creds.txt",
      "docker login --password-stdin < creds.txt",
    ],
    [
      "sshpass ssh -p 2222 deploy@host.example.test",
      "sshpass ssh -p 2222 deploy@host.example.test",
    ],
    [
      "sshpass -P authprompt ssh deploy@host.example.test",
      "sshpass -P authprompt ssh deploy@host.example.test",
    ],
    // An env assignment whose name merely begins with the same letters is not sshpass's to read,
    // and a global option does not turn a neighbour subcommand into a login: `ps` stays a process
    // list, and `run`'s own `-p` is a port mapping, not docker's registry password.
    [
      "SSHPASS_FILE=/run/secrets/ssh sshpass -e ssh deploy@host.example.test",
      "SSHPASS_FILE=/run/secrets/ssh sshpass -e ssh deploy@host.example.test",
    ],
    [
      "docker -H tcp://registry.example:2375 ps -p 8080:80",
      "docker -H tcp://registry.example:2375 ps -p 8080:80",
    ],
    ["docker run login -p 8080:80 nginx", "docker run login -p 8080:80 nginx"],
    [
      "wget -U Mozilla:5 https://example.test",
      "wget -U Mozilla:5 https://example.test",
    ],
  ];
  for (const [input, output] of cases) {
    test(input, () => expect(scrubCommand(input)).toBe(output));
  }
  test("a command continued with a backslash is still one command to its password flag", () => {
    expect(scrubCommand("mysql -uroot \\\n  -pglorbwibble appdb")).toBe(
      "mysql -uroot \\\n  -p[REDACTED] appdb",
    );
  });
  test("a line break starts another command, so its -p is a port again", () => {
    expect(
      scrubCommand("mysql -uroot appdb\nssh -p2222 deploy@host.example.test"),
    ).toBe("mysql -uroot appdb\nssh -p2222 deploy@host.example.test");
  });
  test("an ordinary command is untouched", () => {
    expect(scrubCommand("ls -la /workspace && git status")).toBe(
      "ls -la /workspace && git status",
    );
  });
  test("a run of empty quoted pairs cannot stall the scrubber", () => {
    // Before R10-C7 the quote arms overlapped: a pair could be taken whole, split into lone
    // quotes, or re-paired across pairs, so a non-matching tail walked ~2^n derivations — twenty
    // pairs stalled the loop for 0.6-3.4s (the adjudication measured 602.87ms; forty pairs run to
    // minutes). Each quote now has exactly one arm that can match it, so the same inputs stay flat
    // at any count. None of these carries a `-p`, so the output is the input, unchanged.
    const shapes = [
      (n: number) => `mysql ${'"" '.repeat(n)}`,
      (n: number) => `mysql ${"'' ".repeat(n)}`,
      (n: number) => `sshpass ${'-f "" '.repeat(n)}-v`,
    ];
    const start = performance.now();
    for (const build of shapes)
      for (const n of [8, 12, 16, 20, 24, 40]) {
        const input = build(n);
        expect(scrubCommand(input)).toBe(input);
      }
    expect(performance.now() - start).toBeLessThan(1000);
  });
  test("a quote held open by a line continuation cannot stall the scrubber either", () => {
    // Pairing must stay unambiguous when the closing quote sits past a `\` + line break: the
    // fallback fires only while no closing quote is left to reach — through the continuation too
    // — so one derivation remains per quote however many are stacked.
    const input = `mysql ${'"\\\nx" '.repeat(40)}-q`;
    const start = performance.now();
    expect(scrubCommand(input)).toBe(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
