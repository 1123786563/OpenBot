/*
 * The observation chains' shared screen-state vocabulary. StateNotice was written once
 * for the runs list and then copied — by the time the copies were importing each other
 * across files (dataset-detail from datasets-list, comparison and results from
 * runs-list), a style or semantics tweak on one side silently diverged the others (OCR
 * round 1 medium, duplicated StateNotice). Both exports live here so the four-word
 * fault derivation and the sentence that renders it can only move together.
 */

/** One availability sentence: a title and the description that qualifies it. */
export function StateNotice({
  className,
  description,
  title,
}: {
  className?: string;
  description: string;
  title: string;
}) {
  return (
    <div className={className} role="status">
      <p className="font-medium text-sm">{title}</p>
      <p className="mt-1 max-w-prose text-muted-foreground text-sm">
        {description}
      </p>
    </div>
  );
}

/**
 * The screen-level verdict every observation page derives the same way (OCR round 1
 * medium, four copied nested ternaries): a transport-level error is the store failing
 * to answer — unavailable; the query's own fault view is that verdict, word for word;
 * anything else means the page has something of its own to draw. Structural on
 * purpose: each chain's screen union feeds it without naming this file.
 */
export function observationScreenFault<F extends string>(screen: {
  error: unknown;
  data?: { view: unknown; fault?: F };
}): "unavailable" | F | null {
  if (screen.error) return "unavailable";
  const data = screen.data;
  return data !== undefined && data.view === "fault" && data.fault !== undefined
    ? data.fault
    : null;
}
