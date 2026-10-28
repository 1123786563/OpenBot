/**
 * Take the secrets out of a shell command before it is kept or exported.
 *
 * The approach is the one secret scanners use (gitleaks, detect-secrets, GitHub secret scanning):
 * known token shapes by prefix, then credentials by the name they are passed under, then anything in
 * a URL's userinfo. Each match is replaced with `[REDACTED]` in place, so the command stays readable
 * ("curl -H 'Authorization: Bearer [REDACTED]' https://api.example.com") and an investigator can see
 * what was run without the record becoming a credential store.
 *
 * Deliberately over-eager. A redacted word that was not a secret costs a reader a guess; a secret
 * that survived costs a rotation.
 */

const REDACTED = "[REDACTED]";

/** Token shapes with a vendor prefix or a fixed form. */
const TOKEN_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI, Anthropic
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b(sk|rk)_(live|test)_[0-9a-zA-Z]{16,}\b/g, // Stripe
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
];

/** Names a credential is usually passed under, as an assignment, a flag or a header. */
const SECRET_NAME =
  "(?:[A-Za-z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)";

/*
 * The shell-lexical arms every positional rule below is built from, held once here so an arm
 * adjusted cannot drift between the five rules' copies (R14 F14-1) — every drift defect so far
 * (A-H1, F04-6, T14, R8-C5, R10-C7) lived in one copy disagreeing with another. QUOTE_ARMS is a
 * paired double- or single-quoted word beside the fallback that reads an unpaired quote as an
 * ordinary character, each fallback guarded so exactly one arm can match at a quote (R10-C7).
 *
 * Residual window, recorded as it is: a quoted secret that truly closes on a later line is
 * redacted only up to the line break, and the rest of it stays in the record. Pairing a quote
 * across lines is what swallowed whole following command lines when the quote was never closed
 * (F10-2, pinned by T30), so no reading satisfies both — the choice is that a later-closing
 * secret leaks rather than that a command is deleted. bash keeps a newline inside double quotes
 * as part of the word, so this departs from the shell's reading by choice, not by derivation from
 * it. PEM blocks and long vendor tokens are caught by TOKEN_SHAPES whatever their line breaks.
 *
 * LEAD_SPAN is a lead's run from its anchor word to its flag, a VALUE_UNIT is one unit of a bare
 * value, and BARE_VALUE is the value word, its first unit refusing `-` and the separators. The
 * rules interpolate them the way the SECRET_NAME rules interpolate their name, each with its
 * own flags.
 */
const QUOTE_ARMS = String.raw`"(?:\\[\s\S]|[^"\\\r\n])*"|"(?!(?:\\[\s\S]|[^"\\\r\n])*")|'[^'\r\n]*'|'(?![^'\r\n]*')`;
const LEAD_SPAN = String.raw`(?:[^|;&\\\r\n"']|${QUOTE_ARMS}|\\[\s\S])*?`;
const VALUE_UNIT = String.raw`(?:\\[^\r\n]|${QUOTE_ARMS}|[^\s'";|&\\])`;
const BARE_VALUE = String.raw`(?:\\[^\r\n]|${QUOTE_ARMS}|[^\s'";|&\\-])${VALUE_UNIT}*`;

const RULES: [RegExp, (match: string, ...groups: string[]) => string][] = [
  // Authorization headers: `Authorization: Bearer x`, `-H "Authorization: Basic x"`.
  [
    /(authorization\s*[:=]\s*(?:bearer|basic|token|digest)?\s*)("[^"]*"|'[^']*'|[^\s'"]+)/gi,
    (_match, lead) => `${lead}${REDACTED}`,
  ],
  [
    /(x-api-key\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s'"]+)/gi,
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  /*
   * Credentials passed positionally: the value is the word after the flag, so nothing in the command
   * names it and the rules below cannot see it. Tool-anchored, and checked before them because a
   * generic rule can mistake an attached short-form password for a flag name — `redis-cli -asecret`
   * reads as a flag called `-asecret`, and the rule for a flag named after a secret then redacts the
   * word after it instead of the password.
   *
   * Each of these refuses a value that begins with `-`, so a flag left bare, which asks for the
   * password interactively, does not swallow the flag that follows it. And each ends where its
   * command does: at a line break, which starts another command whose `-p` is a port again, though
   * not at a line continued with a backslash, which is the same command. A bare value stops at
   * `;`, `|` and `&` too — in the shell's reading they start another command, an unquoted password
   * cannot contain them, and redacting past one would make the command that followed disappear
   * from the record (`docker login -p pass;whoami` folds `pass;whoami` into one token and the
   * audit trail loses `whoami`). Nor does a bare value begin with one: a token whose first
   * character is a separator is not a single argv word — `docker login -p;whoami` asks for the
   * password at the prompt and then runs `whoami` — so there is nothing on the line to redact,
   * and refusing it whole keeps the command after the separator in the record. A quoted value
   * keeps its separators: inside the quotes they are part of the word, not the shell's.
   *
   * A quoted argument is consumed whole, quotes and all. The scan still stops at a line break
   * inside the quotes — the residual window that leaves is recorded at QUOTE_ARMS — but a `;`, `|`
   * or `&` inside the quotes belongs to the quoted word, not to the shell listing commands, so it
   * must not end the sweep before the flag is found (`mysql -e "SELECT 1;" -p…`,
   * `docker login -u "a&b" -p…`). An unclosed quote just ends the scan there instead of reading
   * on, which is what keeps the lines that follow in the record.
   *
   * A double-quoted word may itself hold an escaped quote (`docker login -u "dev\"ops" -p…`). The
   * arm consumes the backslash and the character it escapes as a pair: `[^"\\\r\n]` alone would
   * end the word at the escaped `"`, and the dangling quote left over would stop the scan short of
   * the flag — the same shape an unclosed quote makes. Single quotes have no escapes in the shell,
   * so that arm keeps its literal reading.
   *
   * A quote with no pair to close it (`o'brien`, one `"` too few) falls back to its old reading as
   * an ordinary character: the quote arms still take a paired quote whole, and an unpaired one no
   * longer leaves the scan stuck short of the flag. The value after the flag reads the same way —
   * a run of bare characters and paired quote segments — so a quote segment inside the word
   * (`docker login -p a"b;c"`, one argv word in the shell) stays part of the secret instead of
   * ending it at the `;` inside the quotes, while the word still refuses to begin with a separator
   * and still ends at an unquoted one.
   *
   * The fallback is guarded by a lookahead — a quote falls back to an ordinary character only when
   * no same-type closing quote is left to reach on the line or through a backslash continuation —
   * so at every quote exactly one arm can match. With the bare fallback, overlapping arms let one
   * input split into exponentially many derivations, and a non-matching tail (`mysql "" "" …`
   * without the `-p`) walked them all, stalling the loop for seconds on twenty pairs (R10-C7).
   *
   * The value's quote arms stop at a bare line break the same way the lead's do — an unclosed
   * quote there used to swallow the whole next line into the redaction (`docker login -p "oops`
   * and a second line of commands after it), deleting those commands from the record. And a
   * backslash in a bare value escapes the character after it, as it does in the shell: `pa\;ss`
   * is one argv word, the `;` escaped rather than a command separator, so the value arm consumes
   * backslash pairs and the word is redacted whole instead of ending at the backslash and leaving
   * the rest of the password in the record. A backslash at the value's line break is a
   * continuation, not a word character: the word ends before it.
   */
  // `-psecret` for mysql and friends. Nothing separates them: a space means the password is asked for
  // at the prompt and the word after `-p` is the database, so only the attached form is redacted.
  // Case-sensitive on purpose, unlike the upstream source: an uppercase `-P` is how mysql attaches a
  // port (`mysql -h db -P3306`), and upstream's `i` reads it as a password — redacting the port while
  // a real `-phunter2` later in the same command line survives.
  [
    new RegExp(
      String.raw`(\bmysql(?:dump)?\b${LEAD_SPAN}(?:[ \t]|\\\r?\n)-p)(${BARE_VALUE})`,
      "g",
    ),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `docker login -p secret`, where `-p` is the password rather than a port. docker's grammar puts
  // global options between the command and its subcommand (`docker -H tcp://… login`), so a flag —
  // and that flag's own value, a word that does not start with `-` — may sit in between. A
  // subcommand cannot: `run` is not a flag, which is what keeps `docker run login -p 8080:80` a
  // port mapping instead of a registry password.
  [
    new RegExp(
      String.raw`(\bdocker(?:(?:[ \t]|\\\r?\n)+-[^\s]+(?:[ \t]+[^\s-]\S*)?)*?(?:[ \t]|\\\r?\n)+login\b${LEAD_SPAN}(?:[ \t]|\\\r?\n)-p[ \t]*)(${BARE_VALUE})`,
      "gi",
    ),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `sshpass -p secret ssh user@host`, where `-p` is the password handed to ssh. Only sshpass's own
  // options are read, `-f file`, `-d fd` and `-P prompt` with the word after them, so the command it
  // wraps keeps its `-p` and `-P`, which are ports. Case matters here: `-P` is sshpass's prompt.
  //
  // The bare-flag arm reads one cluster with no `p` in it and with no value glued to one of its
  // flags (`-(?![fdP](?=\S))[^\sp]+`, no unconstrained tail):
  // getopt folds `-v` into the next option, so `-vp hunter2` is `-v -p hunter2`, and a tail like
  // `\S*` would swallow the whole cluster — `p` and all — and never reach the password. Instead the
  // cluster's `p` is where the lead ends: the terminator matches a `-p` on its own or at the end of
  // such a cluster (`-[^\sfdPp]*p`), with `f`, `d` and `P` kept out of the cluster so `-Pprompt`
  // stays a prompt value rather than reading as a cluster ending in a password flag. The cluster
  // keeps a lowercase `p` out too: a `p` allowed inside would let the greedy run backtrack into an
  // attached password that itself contains one — `sshpass -phunter2p ssh user@host` read the
  // password as the cluster and redacted the `ssh` after it, leaving the password whole in the
  // lead — so, with `p` barred from the cluster, the `p` that ends the terminator can only be the
  // flag's own. The cluster arm still takes a lowercase `p` only; uppercase `-P` never ends the
  // lead as one.
  //
  // The guard on the cluster's head is the same single-derivation rule the quote arms were given
  // (R10-C7): a token like `-fa` or `-Pprompt` reads two ways over one span — as the `-[fdP]` arm,
  // a flag with its value attached, or as one long cluster — and a lazy loop handed two readings
  // walks 2^n of them into a dead tail (`sshpass -fa -fa …` with no `-p` after it stalled for a
  // quarter second at twenty-four clusters and four seconds at twenty-eight; T18 R1-F1). The
  // cluster is refused only where the value is glued straight on: a `-f` that stands apart from
  // its value still clusters, its two readings ending at different places, the shorter dead where
  // the value begins, and `-v` and `-q` never had a second reading to lose.
  [
    new RegExp(
      String.raw`(\bsshpass(?:(?:[ \t]|\\\r?\n)+(?:-[fdP][ \t]*${BARE_VALUE}|-(?![fdP](?=\S))[^\sp]+))*?(?:[ \t]|\\\r?\n)+-[^\sfdPp]*p[ \t]*)(${BARE_VALUE})`,
      "g",
    ),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `SSHPASS=secret sshpass -e ssh host`: the env form sshpass itself recommends over `-p`, because
  // the password stays out of the process list. `-e` carries no value of its own — the assignment in
  // front is the secret — and SSHPASS names no full word the NAME=value rule matches (no
  // PASSWORD/PASSWD/PWD inside it), so without this rule the password survives verbatim. Its bare
  // arm stops at `;`, `|` and `&` for the same reason the positional values above do: they end the
  // assignment and start another command, which must stay in the record — and does not begin with
  // one either (`SSHPASS=;cmd` is an empty assignment before another command, no secret to take).
  [
    new RegExp(String.raw`(\bSSHPASS\s*=\s*)(${VALUE_UNIT}+)`, "g"),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `redis-cli -a secret`, `-asecret` and `--pass secret`, the same shape under redis-cli's names.
  [
    new RegExp(
      String.raw`(\bredis-cli\b${LEAD_SPAN}(?:[ \t]|\\\r?\n)(?:-a[ \t]*|--pass(?:=|[ \t]+)))(${BARE_VALUE})`,
      "gi",
    ),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // A quoted key in a JSON body: `-d '{"password":"x"}'`, or `-d "{\\"password\\":\\"x\\"}"` once the
  // shell quoting around it has escaped the inner quotes. The rule below stops at the closing quote
  // of the key, so it never saw these.
  [
    new RegExp(
      `(\\\\?["']${SECRET_NAME}\\\\?["']\\s*:\\s*)(\\\\"[^"\\\\]*\\\\"|"[^"]*"|'[^']*'|[^\\s,}'"\\\\]+)`,
      "gi",
    ),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `NAME=value`, `export NAME=value`, `--name=value`, `NAME: value`.
  [
    new RegExp(
      `((?:--?)?${SECRET_NAME}\\s*[=:]\\s*)(?!\\[REDACTED\\]|(?:bearer|basic|token|digest)\\s)("[^"]*"|'[^']*'|[^\\s'"]+)`,
      "gi",
    ),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `--password value`, `--token value`.
  [
    new RegExp(
      `(--?${SECRET_NAME}\\s+)("[^"]*"|'[^']*'|[^\\s'"-][^\\s'"]*)`,
      "gi",
    ),
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // `curl -u user:password`, and the other ways curl takes it: `-uuser:password`,
  // `--user=user:password`, `--proxy-user user:password`, and any of them with the pair in quotes.
  // curl's short form for the proxy is `-U`, which is deliberately not here: `-U` is a user agent to
  // wget and an unrelated flag to ssh, and a pair like `wget -U Mozilla:5` is not a credential.
  [
    /(\s(?:-u\s*|--user(?:=|\s+)|--proxy-user(?:=|\s+)))(?:"([^":]*):[^"]*"|'([^':]*):[^']*'|([^\s:"']+):\S+)/g,
    (_m, lead, doubleQuoted, singleQuoted, bare) => {
      const user = doubleQuoted ?? singleQuoted ?? bare;
      return `${lead}${user}:${REDACTED}`;
    },
  ],
  // Userinfo in any URL: `https://user:pass@host`. The user is optional, because
  // `redis://:pass@host` is how a password-only scheme is written.
  [
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s/@]+)@/gi,
    (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`,
  ],
  // Cookie headers: `Cookie: session=…`, `cookie: a=b; c=d`, `set-cookie: …`. A session cookie is a
  // bearer credential with a different casing (MT109/Issue #152): the value goes whole, like the
  // Authorization header's — the names a cookie carries name nothing the reader needs.
  [
    /((?:set-)?cookie\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s'"]+)/gi,
    (_m, lead) => `${lead}${REDACTED}`,
  ],
  // OAuth's query-borne credentials: the authorization `code`, the access/refresh token and the
  // client secret as a provider's callback or token URL carries them (`?code=…&state=…`). The
  // parameter keeps its name — that is the diagnosis — and loses its value.
  [
    /([?&](?:code|access_token|refresh_token|client_secret)=)[^&\s'"]+/gi,
    (_m, lead) => `${lead}${REDACTED}`,
  ],
];

export function scrubCommand(command: string): string {
  let scrubbed = command;
  for (const shape of TOKEN_SHAPES)
    scrubbed = scrubbed.replace(shape, REDACTED);
  for (const [pattern, replace] of RULES) {
    scrubbed = scrubbed.replace(
      pattern,
      replace as (substring: string, ...args: string[]) => string,
    );
  }
  return scrubbed;
}
