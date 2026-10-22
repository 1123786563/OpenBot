import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import {
  describeApproval,
  type SharedUseApproval,
} from "@/lib/plugins/shared-use";

export function sharedSectionSentence(
  effect: "read" | "write",
  shared: boolean,
  t: TFunction<"admin">,
): string | null {
  if (!shared) return null;
  return effect === "write"
    ? t("sharedApproval.sectionWrite")
    : t("sharedApproval.sectionRead");
}

/**
 * Who may use a shared account through one Bot: the audience the Bot has now, offered as the
 * default, and only ever NARROWED here. Named people are offered only when the Bot is published to
 * named people, because that list is what a `people` approval records.
 */
export function SharedApprovalFields({
  value,
  onChange,
}: {
  value: SharedUseApproval;
  onChange: (next: SharedUseApproval) => void;
}) {
  const { t } = useTranslation("admin");
  const named = value.audience === "people" || value.members.length > 0;
  const options: { audience: SharedUseApproval["audience"]; label: string }[] =
    [
      { audience: "owner", label: t("sharedApproval.onlyOwner") },
      ...(named
        ? [
            {
              audience: "people" as const,
              label: t("sharedApproval.named", {
                description: describeApproval({
                  ...value,
                  audience: "people",
                  outsideInput: false,
                }),
              }),
            },
          ]
        : []),
      { audience: "team", label: t("sharedApproval.everyone") },
    ];
  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="font-medium">{t("sharedApproval.whoMayUse")}</legend>
      {options.map((option) => (
        <label className="flex items-center gap-2" key={option.audience}>
          <input
            checked={value.audience === option.audience}
            name="shared-audience"
            onChange={() =>
              onChange({
                ...value,
                audience: option.audience,
                members: option.audience === "people" ? value.members : [],
              })
            }
            type="radio"
          />
          {option.label}
        </label>
      ))}
      {/* The app checkbox, not a bare input: the same RAC base as the sign-in form
          remember-me, so pointer, keyboard and the hidden input stay one path. */}
      <Checkbox
        checked={value.outsideInput}
        className="text-sm"
        onCheckedChange={(checked) =>
          onChange({ ...value, outsideInput: checked })
        }
      >
        {t("sharedApproval.outsideInput")}
      </Checkbox>
    </fieldset>
  );
}
