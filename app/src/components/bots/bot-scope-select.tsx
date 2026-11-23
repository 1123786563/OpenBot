import type { AgentProfile } from "@/lib/agents/queries";

export function BotScopeSelect({
  bots,
  onChange,
  value,
}: {
  bots: readonly AgentProfile[];
  onChange: (id: string) => void;
  value: string;
}) {
  return (
    <label className="mt-6 grid max-w-xs gap-2 text-sm">
      Bot
      <select
        className="w-full rounded-md border border-border bg-background p-2 focus-visible:outline-2 focus-visible:outline-ring"
        onChange={(event) => onChange(event.target.value)}
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
    </label>
  );
}
