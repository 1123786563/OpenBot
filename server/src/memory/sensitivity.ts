/**
 * What a memory holds, at its most conservative.
 *
 * Only content that names its class outright is sensitive: an explicit word ("password",
 * "diagnosed", "salary", "client list") or a shape only a credential has (`sk-…` keys). Anything
 * less — "the login bug", "owns the billing migration" — is `normal`, because a category guessed
 * from a hunch would make the person's ordinary facts unlearnable. One class deliberately errs the
 * other way: a credential the classifier cannot rule out is refused rather than learned
 * (`token of appreciation` is still `credential`), because a leaked password cannot be unlearned
 * while a refused compliment costs nothing.
 *
 * Classification never throws and never treats where text came from as permission: a connector
 * record that happens to contain a diagnosis is just as medical as one the person typed.
 */
export type SensitivityClass =
  | "credential"
  | "medical"
  | "financial"
  | "customer-data"
  | "normal";

/** Said to the person (or the Bot) when a credential is refused, ask or no ask. */
export const CREDENTIAL_REFUSAL =
  "Credentials are never remembered. OpenBot refuses passwords, tokens, passphrases and keys even when asked to remember them.";
/** Said to the Bot that observed sensitive material the person never asked to keep. */
export const SENSITIVE_OBSERVATION_REFUSAL =
  "Medical, financial and customer information is kept only when the person asks for it themselves, never from what a Bot observes.";

/**
 * Credential shapes, most certain first. `token` and `credential` alone count: a memory that
 * merely might be a credential is refused, which is the one place this classifier over-matches.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bpass ?words?\b/i,
  /\bpasswd\b/i,
  /\bpassphrases?\b/i,
  // `pwd` and `pass code` count when they carry a value: after `=`/`:` any token at all
  // (`pwd=hunter2`, `pwd: x`); after "is" only a value-shaped token — one holding a digit or a
  // non-punctuation symbol — so "the passcode is required" and "our pwd is wrong" stay prose
  // (a sentence period does not make one) while "pwd is hunter2" is refused.
  /\bpwd\b\s*(?:[=:]\s*\S+|\bis\s+(?=\S*(?:\d|[^\w\s.,!?;:]))\S+)/i,
  /\bpass ?codes?\b\s*(?:[=:]\s*\S+|\bis\s+(?=\S*(?:\d|[^\w\s.,!?;:]))\S+)/i,
  /\bapi[ _-]?keys?\b/i,
  /\bssh[ _-]?keys?\b/i,
  /\bsecret[ _-]?keys?\b/i,
  /\baccess[ _-]?keys?\b/i,
  /\bprivate[ _-]?keys?\b/i,
  // A PEM file named as a file (`server.pem`); the acronym alone is a format, not a secret.
  /\b[a-z0-9][a-z0-9._-]*\.pem\b/i,
  /\btokens?\b/i,
  /\bcredentials?\b/i,
  /\bsk-(?:live|test|proj|ant|org)-[a-z0-9][a-z0-9-]{5,}\b/i,
  /\bsk-[a-z0-9-]{16,}\b/i,
  // Underscore-style provider prefixes the hyphenated `sk-` patterns above cannot reach:
  // Stripe secret/restricted keys (`sk_live_…`, `sk_test_…`, `rk_live_…`) and the
  // fine-grained GitHub PAT (`github_pat_…`, underscored where the `ghp_…` shapes are not).
  /\b(?:sk|rk)_(?:live|test)_[a-z0-9]{10,}\b/i,
  /\bgithub_pat_[a-z0-9_]{20,}\b/i,
  // A credential name followed by a separator and a long token-shaped value
  // (`client_secret=9f8e7d…`, `API_KEY: 0a1b2c…`, `SECRET=…`, `password=…`): the name alone
  // is prose ("rotate the client secret tomorrow"), so the value must be long (16+ chars)
  // and token-shaped — letters and digits mixed with `_-.` — mirroring the `[=:]`-delimiter
  // stance of `pwd`/`pass code` above, so "secret: none" stays ordinary text ("secret" has no
  // name-only pattern in this list — it matches only by value shape). "password: see the vault",
  // by contrast, is refused on its name alone by the leading `pass words` pattern at the top —
  // the module's one deliberate over-match — before any value shape is consulted.
  /\bclient[ _-]secrets?\b[=:]\s*[a-z0-9][a-z0-9._-]{15,}/i,
  /\b(?:api_?key|secret|password)s?\b[=:]\s*[a-z0-9][a-z0-9._-]{15,}/i,
  // Recovery material the person may paste verbatim (recovery/seed phrase or words, mnemonic).
  // The name alone is prose ("the recovery phrase is explained in the docs"), so a word-list
  // value must follow — after a separator, "is", or nothing at all: 3+ consecutive words of
  // 3-8 letters each (the BIP-39 shape; real phrases are 12+ words). No word of the list may
  // be one of the grammar, number or list-prose words in the lookahead, so "for the wallet is
  // in the vault" and "written on paper" never accumulate a value; as with `token of
  // appreciation` above, a rare 3-word prose run past the name errs toward refusing.
  /\b(?:(?:recovery|seed) ?(?:phrases?|words?)|mnemonics?)\b(?:\s*[=:]\s*|\s+is\s+|\s+)(?:(?!(?:the|and|for|are|was|were|has|had|have|will|would|can|could|should|must|not|with|from|that|this|these|those|into|onto|your|you|our|his|her|its|their|been|being|does|one|once|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|through|number|numbers|list|listed|below|above|shown|written|printed|kept|stored|needed|required|explained|mentioned|described|discussed|follows|consists|contains|device|devices|rhyme|rhymes|trick|tricks|verse|verses|acronym|aid|aids)\b)[a-z]{3,8}\s+){2}(?!(?:the|and|for|are|was|were|has|had|have|will|would|can|could|should|must|not|with|from|that|this|these|those|into|onto|your|you|our|his|her|its|their|been|being|does|one|once|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|through|number|numbers|list|listed|below|above|shown|written|printed|kept|stored|needed|required|explained|mentioned|described|discussed|follows|consists|contains|device|devices|rhyme|rhymes|trick|tricks|verse|verses|acronym|aid|aids)\b)[a-z]{3,8}\b/i,
  // 2FA/MFA backup codes: the name (two-factor/2FA/MFA, optionally followed by backup, or a
  // bare "backup code") followed by a numeric value — 4+ digits, grouped the way services
  // print them ("8722 0091"). "backup codes are required" names no value and stays prose.
  /\b(?:(?:two[- ]factor|2fa|mfa)\s+(?:backup\s+)?|backup\s+)codes?\b\s*(?:[=:]\s*|is\s+)?(?:\d{4,}|\d[\d -]{2,}\d)\b/i,
  // OTP / verification / auth codes: the name followed by a 4-8 digit value, the shape a
  // one-time code arrives in ("OTP is 482913"). A name with no digits after it ("verification
  // codes expire") stays prose, and a longer digit run is some other number, not a code.
  /\b(?:otp|verification|auth(?:entication)?)\s+codes?\b\s*(?:[=:]\s*|is\s+)?\d{4,8}\b/i,
  /\botp\b\s*(?:[=:]\s*|is\s+)?\d{4,8}\b/i,
  /-----begin [a-z0-9 ]*private key-----/i,
  /\b(?:ghp|gho|ghu|ghs)_[a-z0-9]{20,}\b/i,
  /\bxox[baprs]-[a-z0-9-]{10,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  // A Bearer value must contain a digit or a symbol: prose like "Bearer authentication is used by
  // the API" is a description, while only real token shapes carry one.
  /\bbearer\s+(?=[a-z0-9._~+/=-]*[0-9._~+/=-])[a-z0-9._~+/=-]{12,}\b/i,
  // A database URL with credentials in it (`postgres://user:pass@host/db`). The same schemes
  // without a `user:password@` part name a server, not a secret.
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@/i,
];

/** Medical material, by the words that name it. A hospital's name alone is not one of them. */
const MEDICAL_PATTERNS: readonly RegExp[] = [
  /\bdiagnos\w*\b/i,
  /\bchemo\w*\b/i,
  /\bradiotherap(?:y|ies)\b/i,
  /\bmedications?\b/i,
  /\bprescriptions?\b/i,
  /\bblood pressure\b/i,
  /\bdiabetes\b/i,
  /\bdialysis\b/i,
  /\bvaccin\w*\b/i,
  /\btherap(?:y|ies)\b/i,
  /\bmedical (?:record|history|condition|leave|bill)s?\b/i,
  /\bhealth records?\b/i,
];

/** The person's own money, by the words that name it. Bills they send a vendor are not it. */
const FINANCIAL_PATTERNS: readonly RegExp[] = [
  /\bsalar(?:y|ies)\b/i,
  /\bpayrolls?\b/i,
  /\bpay ?checks?\b/i,
  /\bwages?\b/i,
  /\biban\b/i,
  /\b(?:credit|debit) cards?\b/i,
  /\bbank accounts?\b/i,
  /\bbank statements?\b/i,
  /\bmortgages?\b/i,
  /\btax returns?\b/i,
  /\bpension\w*\b/i,
  /\bnet worth\b/i,
];

/** Other people's data in this person's keeping, by the words that name it. */
const CUSTOMER_DATA_PATTERNS: readonly RegExp[] = [
  /\bcustomer (?:data|lists?|emails?|records?|information|details?|contacts?)\b/i,
  /\bclient (?:data|lists?|emails?|records?|information|details?|contacts?)\b/i,
  /\bpersonally identifiable\b/i,
];

const CLASSES: readonly [SensitivityClass, readonly RegExp[]][] = [
  ["credential", CREDENTIAL_PATTERNS],
  ["medical", MEDICAL_PATTERNS],
  ["financial", FINANCIAL_PATTERNS],
  ["customer-data", CUSTOMER_DATA_PATTERNS],
];

/**
 * Classify one memory's content. First explicit match wins, most severe class first, so a bank
 * statement with a password in it is a credential. Anything unmatched — and anything the classifier
 * cannot read at all — is `normal`: failing closed on "sensitive" would block ordinary facts, so
 * the failure lands on the safe side of each class's own rule (see the module comment).
 */
export function classifyMemorySensitivity(content: string): SensitivityClass {
  if (typeof content !== "string" || !content.trim()) return "normal";
  try {
    for (const [sensitivity, patterns] of CLASSES)
      if (patterns.some((pattern) => pattern.test(content))) return sensitivity;
  } catch {
    return "normal";
  }
  return "normal";
}
