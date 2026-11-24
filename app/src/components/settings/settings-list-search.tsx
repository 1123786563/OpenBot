import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { Ref } from "react";

export function SettingsListSearch({
  noun,
  placeholder,
  value,
  inputRef,
  onChange,
  onEnter,
  matches,
  total,
}: {
  noun: string;
  placeholder: string;
  value: string;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
  onEnter: () => void;
  matches: number;
  total: number;
}) {
  return (
    <VStack gap={2}>
      <TextInput
        autoComplete="off"
        controlClassName="min-h-11 [&_input]:min-h-11 [&_button]:min-h-11 [&_button]:min-w-11"
        controlStyle={{ paddingInlineStart: "var(--spacing-3)" }}
        hasAutoCorrect={false}
        hasClear
        hasSpellCheck={false}
        label={`Search ${noun}`}
        onChange={onChange}
        onEnter={onEnter}
        placeholder={placeholder}
        ref={inputRef}
        size="lg"
        type="search"
        value={value}
        width="100%"
      />
      {value.trim() ? (
        <Text as="p" role="status" size="sm" color="secondary">
          {matches ? `${matches} of ${total} ${noun}` : `No matching ${noun}.`}
        </Text>
      ) : null}
    </VStack>
  );
}

export function settingsSearchTerms(query: string) {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}
