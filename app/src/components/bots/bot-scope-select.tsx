import { IconChevronDown } from "@tabler/icons-react";
import type { Ref } from "react";
import type { AgentProfile } from "@/lib/agents/queries";

export function BotScopeSelect({
  bots,
  onChange,
  selectRef,
  value,
}: {
  bots: readonly AgentProfile[];
  onChange: (id: string) => void;
  selectRef?: Ref<HTMLSelectElement>;
  value: string;
}) {
  return (
    <label className="mt-6 grid max-w-xs gap-2 text-sm">
      Bot
      <select
        className="col-start-1 row-start-2 min-h-11 w-full appearance-none rounded-md border border-border bg-background p-2 pe-9 focus-visible:outline-2 focus-visible:outline-ring"
        onChange={(event) => onChange(event.target.value)}
        ref={selectRef}
        value={value}
      >
        {!value ? (
          <option disabled value="">
            Choose a Bot
          </option>
        ) : null}
        {bots
          .filter((bot) => !bot.hidden)
          .map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
      </select>
      <IconChevronDown
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-2 me-3 size-4 self-center justify-self-end"
      />
    </label>
  );
}
