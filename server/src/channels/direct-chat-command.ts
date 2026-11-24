// Match the same whitespace in JavaScript and PostgreSQL.
export const reflectCommandPrefix =
  /^\/reflect[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

const reflectPattern = new RegExp(
  `${reflectCommandPrefix.source}+([\\s\\S]{1,200})$`,
);

export function reflectCommand(prompt: string) {
  return prompt.match(reflectPattern)?.[1]?.trim();
}
