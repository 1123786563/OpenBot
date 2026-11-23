import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import type { CSSProperties, ReactNode } from "react";
import logo from "@/assets/openbot-logo.png";
import { appConfig } from "@/lib/generated/application-config";

function accent(value: string | undefined, fallback: string) {
  const fill = value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(fill.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return { fill, text: luminance > 0.179 ? "#000000" : "#ffffff" };
}

const light = accent(
  import.meta.env.VITE_OPENBOT_ASTRYX_ACCENT_LIGHT,
  "#5148ae",
);
const dark = accent(import.meta.env.VITE_OPENBOT_ASTRYX_ACCENT_DARK, "#bab7ff");
const brandStyle: CSSProperties & Record<`--${string}`, string> = {
  "--pilot-accent-light": light.fill,
  "--pilot-on-accent-light": light.text,
  "--pilot-accent-dark": dark.fill,
  "--pilot-on-accent-dark": dark.text,
};

export const astryxScope = {
  "data-astryx-theme": "neutral",
  "data-astryx-pilot": "",
  style: brandStyle,
};

export function AstryxSurface({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  return (
    <div {...astryxScope} className={className}>
      {children}
    </div>
  );
}

export function AstryxBrand() {
  const brandLogo = import.meta.env.VITE_OPENBOT_ASTRYX_BRAND_LOGO || logo;
  return (
    <HStack align="center" gap={2} style={{ minWidth: 0 }}>
      <img
        alt=""
        src={brandLogo}
        style={{
          blockSize: "var(--spacing-5)",
          inlineSize: "var(--spacing-5)",
          objectFit: "contain",
          flexShrink: 0,
        }}
      />
      <Text type="label" maxLines={1} weight="semibold">
        {appConfig.brand.productName}
      </Text>
    </HStack>
  );
}
