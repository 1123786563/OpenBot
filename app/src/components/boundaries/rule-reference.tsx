import { Fragment } from "react";
import { FieldDescription } from "@/components/ui/field";
import { RULE_ATTRIBUTES } from "@/lib/boundaries/rules";

export const RULE_EXPRESSION_HELP_ID = "rule-expression-help";

export function RuleExpressionHelp() {
  return (
    <FieldDescription id={RULE_EXPRESSION_HELP_ID}>
      <span className="block">
        Write a CEL condition. An action matches when the condition is true.
      </span>
      <code className="block whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs">
        tool.name == "computer_key" &amp;&amp; key == "Enter"
      </code>
    </FieldDescription>
  );
}

/**
 * What a rule can check, folded away until it is wanted. It used to be the page's description, a
 * paragraph of attribute names read by everybody to find out what the screen was for.
 */
export function RuleReference() {
  return (
    <details className="text-sm">
      <summary className="min-h-12 cursor-pointer py-3 text-muted-foreground hover:text-foreground">
        What a rule can check
      </summary>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {RULE_ATTRIBUTES.map((attribute) => (
          <Fragment key={attribute.name}>
            <dt>
              <code className="font-mono text-xs">{attribute.name}</code>
            </dt>
            <dd className="text-muted-foreground">{attribute.meaning}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="mt-3 text-muted-foreground">
        A rule that names something an action doesn't have, such as{" "}
        <code className="font-mono text-xs">key</code> on a click, counts as a
        match. Name the tool first, as in the example above, to check attributes
        only on actions that have them.
      </p>
    </details>
  );
}
