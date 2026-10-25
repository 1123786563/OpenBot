import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { scrubCommand } from "../src/telemetry/scrub";

/*
 * The regression nails for scrubCommand's adversarial boundaries, at the unit level the scrub.ts
 * comments speak in. Every drift defect those comments cite — R10-C7's single-derivation quote
 * guard, T18 R1-F1's guarded sshpass cluster, T14's escaped quotes, the R2/R8-C5 value-arm
 * revision — was found by a shape like one of these, and each shape here pins it so the next arm
 * adjustment cannot drift silently (R15 F15-3). The scrubbing table in enterprise-controls.test.ts
 * holds the wide shape matrix; this suite is the standing adversarial probe the OCR round asked
 * for, on the Bun tier beside otel-export-scrubbing.test.ts (bun test runs it directly; its
 * membership is recorded in tests/config/e2e-bun-suites.json).
 */
describe("scrubCommand adversarial boundaries", () => {
  test("the ReDoS probe shapes stay flat at thirty tokens", () => {
    // R10-C7: with overlapping quote arms a non-matching tail of empty pairs walked ~2^n
    // derivations — twenty pairs stalled the loop for seconds (the adjudication measured 602.87ms;
    // forty ran to minutes). T18 R1-F1 (fixed in T20): a glued sshpass flag like `-fa` read two
    // ways over one span, so twenty-four dead clusters stalled node for a quarter second and grew
    // ×16 every four more; `-f a` apart from its value is the flat contrast that must stay flat.
    // None of these carries a `-p`, so the output is the input, unchanged — and coarse time bound.
    const shapes = [
      `mysql ${'"" '.repeat(30)}`,
      `sshpass ${"-fa ".repeat(30)}-v`,
      `sshpass ${"-f a ".repeat(30)}-v`,
    ];
    const start = performance.now();
    for (const input of shapes) expect(scrubCommand(input)).toBe(input);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  test("a small run of empty quoted pairs leaves the line unchanged", () => {
    // R10-C7 again, at a count cheap enough to reason about: eight empty pairs, no `-p`, no
    // redaction, byte-identical output.
    const input = `mysql ${'"" '.repeat(8)}`;
    expect(scrubCommand(input)).toBe(input);
  });

  test("a bare value that starts with a separator is nothing to redact", () => {
    // T18 R1-F1's zero-redaction family: a token whose first character is `;` is not a single argv
    // word — `docker login -p;whoami` asks for the password at the prompt and then runs `whoami` —
    // so the line survives whole instead of folding `whoami` into a redaction and deleting it from
    // the audit trail.
    expect(scrubCommand("docker login -p;whoami")).toBe(
      "docker login -p;whoami",
    );
  });

  test("an unclosed quote ends at the line break, not at the end of the record", () => {
    // R10-C7: the value's quote arms stop at a bare line break — the shell would not keep a quote
    // that spans one to a single command — so the second line's command stays in the record. Before
    // the guard the unclosed quote swallowed the whole next line into the redaction.
    expect(scrubCommand('docker login -p "oops\necho "hi"')).toBe(
      'docker login -p [REDACTED]\necho "hi"',
    );
  });

  test("an escaped separator belongs to the bare word, in the separated form", () => {
    // R10-C7: in `pa\;ss` the backslash takes the `;` out of the shell's reading, so the whole word
    // is the password — ending the value at the backslash left `ss` in the record.
    expect(scrubCommand("docker login -p pa\\;ss registry.example.test")).toBe(
      "docker login -p [REDACTED] registry.example.test",
    );
  });

  test("an escaped separator belongs to the bare word, in the attached form", () => {
    // R10-C7, mysql's attached form: `ppa\|ss` is one argv word with an escaped `|`, redacted whole.
    expect(scrubCommand("mysql -h db -ppa\\|ss app")).toBe(
      "mysql -h db -p[REDACTED] app",
    );
  });

  test("an unclosed single quote in the lead falls back to an ordinary character", () => {
    // R2/R8-C5: a quote with no pair to close it (`o'brien`) reads as an ordinary character, so the
    // scan still reaches the flag behind it — the password used to survive whole behind the stall.
    expect(scrubCommand("mysql -u o'brien -phunter2 app")).toBe(
      "mysql -u o'brien -p[REDACTED] app",
    );
  });

  test("an unclosed double quote in the lead falls back the same way", () => {
    // R2/R8-C5, the double-quote twin: `a"b` in the lead leaves the flag reachable.
    expect(
      scrubCommand('docker login -u a"b -p hunter2 registry.example.test'),
    ).toBe('docker login -u a"b -p [REDACTED] registry.example.test');
  });

  test("a paired quote segment inside the value is one word in three of the five rules", () => {
    // R2/R8-C5: the value reads as a run of bare characters and paired quote segments, so `a"b;c"` —
    // one argv word in the shell — is redacted whole instead of ending at the `;` inside the quotes.
    // Three of the five positional rules probed: docker login, mysql's attached form, SSHPASS=.
    expect(scrubCommand('docker login -p a"b;c" registry.example.test')).toBe(
      "docker login -p [REDACTED] registry.example.test",
    );
    expect(scrubCommand("mysql -h db -pa'b;c' app")).toBe(
      "mysql -h db -p[REDACTED] app",
    );
    expect(
      scrubCommand('SSHPASS=a"b;c" sshpass -e ssh deploy@host.example.test'),
    ).toBe("SSHPASS=[REDACTED] sshpass -e ssh deploy@host.example.test");
  });

  test("an attached password carrying its own p and mid-word dashes is taken whole", () => {
    // R8-C5's mid-word `-` allowance behind F04-6's bait: an attached password that itself contains
    // a `p` (the terminator's greedy backtrack used to eat it as the cluster) and dashes inside the
    // word — refused only as the first character — is redacted as one word, and the `ssh` after it
    // survives.
    expect(
      scrubCommand(
        "sshpass -pfixture-pass-8d3a5c1e9b72 ssh deploy@host.example.test",
      ),
    ).toBe("sshpass -p[REDACTED] ssh deploy@host.example.test");
  });

  test("the SSHPASS arm alone lets a leading dash into the value", () => {
    // R8-C5's deliberate divergence: the env assignment's value arm does not refuse a leading `-`
    // the way the positional arms do — a password that begins with a dash is still the whole value
    // of SSHPASS=, so it is redacted whole rather than left in the record.
    expect(
      scrubCommand(
        "SSHPASS=-leading-dash sshpass -e ssh deploy@host.example.test",
      ),
    ).toBe("SSHPASS=[REDACTED] sshpass -e ssh deploy@host.example.test");
  });
});
