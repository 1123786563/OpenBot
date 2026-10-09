/**
 * Every provenance value that means "this row was enabled through a broker".
 *
 * ONE LIST IN `shared/` because two processes need it and they share no module: the server reads it
 * to decide whether a row is brokered at all, and the browser reads it to decide whether a
 * connected-accounts row is a brokered one. A second declaration in `app/src` is the drift the
 * composio string checks already suffered — `provenance === "composio"` written four times across
 * two files, each of which a third broker would have to find.
 */
export const BROKERED_PROVENANCES = ["composio", "open-connector"] as const;

export type BrokeredProvenance = (typeof BROKERED_PROVENANCES)[number];

export function isBrokeredProvenance(
  value: string,
): value is BrokeredProvenance {
  return (BROKERED_PROVENANCES as readonly string[]).includes(value);
}
