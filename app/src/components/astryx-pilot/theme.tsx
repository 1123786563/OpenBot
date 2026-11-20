import type { CSSProperties, ReactNode } from "react";
import logo from "@/assets/openbot-logo.png";
import { appConfig } from "@/lib/generated/application-config";

export const astryxPilot = import.meta.env.VITE_OPENBOT_ASTRYX_PILOT === "1";

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

export const astryxScope = astryxPilot
  ? {
      "data-astryx-theme": "neutral",
      "data-astryx-pilot": "",
      style: brandStyle,
    }
  : {};

export function AstryxSurface({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  if (!astryxPilot) return children;
  return (
    <div {...astryxScope} className={className}>
      {children}
    </div>
  );
}

export function AstryxBrand() {
  const brandLogo = import.meta.env.VITE_OPENBOT_ASTRYX_BRAND_LOGO || logo;
  return (
    <span className="astryx-brand">
      <img alt="" height={20} src={brandLogo} width={20} />
      <span>{appConfig.brand.productName}</span>
    </span>
  );
}
