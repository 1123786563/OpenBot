import { ArrowUpRight, Check, ChevronRight, type LucideIcon, X } from "lucide-react-native";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import Svg, { Circle, Defs, Ellipse, LinearGradient, Path, Stop } from "react-native-svg";
export const colors = {
  canvas: "#FCFCFC",
  card: "#FFFFFF",
  text: "#11191C",
  muted: "#777B7E",
  line: "#EEEEF0",
  blue: "#C8E7FF",
  blueDark: "#1473C8",
  sky: "#EDF7FD",
  green: "#E3F3E8",
  lavender: "#F0EEFA",
  orange: "#FDF0DF",
  danger: "#AA4A45",
};
export const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  text: { color: colors.text, fontSize: 15, lineHeight: 23 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  small: { color: colors.muted, fontSize: 11, lineHeight: 17 },
  label: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  title: { color: colors.text, fontSize: 23, fontWeight: "600", letterSpacing: -0.7 },
  heading: { color: colors.text, fontSize: 16, fontWeight: "600", letterSpacing: -0.25 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 23,
    borderWidth: 0,
    borderColor: colors.line,
    padding: 20,
  },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 18 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 14,
    backgroundColor: "#FFF",
    minHeight: 45,
  },
  field: { gap: 7, marginBottom: 16 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 17,
    minHeight: 42,
    paddingVertical: 10,
    borderRadius: 24,
  },
  primary: { backgroundColor: colors.blue },
  secondary: { backgroundColor: "#F1F2F3" },
  buttonText: { fontSize: 12, fontWeight: "600" },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    alignSelf: "flex-start",
    backgroundColor: colors.canvas,
  },
  chipText: { fontSize: 10, fontWeight: "600", color: colors.muted },
  iconBox: {
    width: 42,
    height: 42,
    borderRadius: 13,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.sky,
  },
  error: { padding: 16, borderRadius: 14, backgroundColor: "#FBEFED", marginVertical: 10, gap: 4 },
  modalShade: {
    flex: 1,
    backgroundColor: "rgba(35,48,44,0.25)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  sheet: {
    backgroundColor: colors.canvas,
    borderRadius: 26,
    width: "100%",
    maxWidth: 790,
    maxHeight: "94%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.line,
  },
});
export function Button({
  children,
  onPress,
  icon: Icon,
  primary,
  disabled,
  busy,
  small,
  danger,
  style,
}: {
  children: ReactNode;
  onPress: () => void;
  icon?: LucideIcon;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  danger?: boolean;
  style?: ViewStyle;
}) {
  const color = danger ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        primary ? s.primary : s.secondary,
        small && { minHeight: 34, paddingVertical: 6, paddingHorizontal: 12 },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} size="small" />
      ) : Icon ? (
        <Icon size={15} color={color} />
      ) : null}
      <Text style={[s.buttonText, { color }]}>{children}</Text>
    </Pressable>
  );
}
export function IconButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        { padding: 10, borderRadius: 22, backgroundColor: pressed ? colors.line : "#FFFFFF" },
      ]}
    >
      <Icon size={18} color={colors.muted} />
    </Pressable>
  );
}
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}
export function Chip({ children, tint }: { children: ReactNode; tint?: string }) {
  return (
    <View style={[s.chip, tint ? { backgroundColor: tint } : null]}>
      <Text style={s.chipText}>{children}</Text>
    </View>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={s.field}>
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        accessibilityLabel={label}
        {...props}
        style={[
          s.input,
          props.multiline && { minHeight: 120, textAlignVertical: "top" },
          props.style,
        ]}
      />
    </View>
  );
}
export function Empty({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <View style={{ alignItems: "center", padding: 40, gap: 13 }}>
      <View style={[s.iconBox, { width: 55, height: 55, borderRadius: 18 }]}>
        <Icon size={24} color={colors.blueDark} />
      </View>
      <Text style={s.heading}>{title}</Text>
      <Text style={[s.muted, { textAlign: "center", maxWidth: 360 }]}>{detail}</Text>
      {children}
    </View>
  );
}
export function ErrorNotice({ error }: { error?: string }) {
  return error ? (
    <View accessibilityRole="alert" style={s.error}>
      <Text style={[s.text, { color: colors.danger }]}>{error}</Text>
    </View>
  ) : null;
}
export function Sheet({
  title,
  subtitle,
  children,
  onClose,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={[s.modalShade, Platform.OS !== "web" && { padding: 10 }]}>
        <View style={[s.sheet, wide && { maxWidth: 1050 }]}>
          <View
            style={[
              s.between,
              { padding: 24, borderBottomWidth: 1, borderBottomColor: colors.line },
            ]}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.title}>{title}</Text>
              {subtitle && <Text style={s.muted}>{subtitle}</Text>}
            </View>
            <IconButton icon={X} label="Close details" onPress={onClose} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24 }}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
export function CheckRow({
  label,
  checked,
  onPress,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[s.row, { gap: 10, paddingVertical: 9 }]}
    >
      <View
        style={{
          width: 19,
          height: 19,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: checked ? colors.text : colors.line,
          backgroundColor: checked ? colors.text : "#FFF",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Check size={13} color="#FFF" />}
      </View>
      <Text style={[s.text, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}
export function SectionHeading({
  title,
  action,
  onPress,
}: {
  title: string;
  action?: string;
  onPress?: () => void;
}) {
  return (
    <View style={[s.between, { marginBottom: 19 }]}>
      <Text style={s.heading}>{title}</Text>
      {action && onPress && (
        <Pressable accessibilityRole="button" onPress={onPress} style={[s.row, { gap: 5 }]}>
          <Text style={[s.small, { color: colors.text }]}>{action}</Text>
          <ArrowUpRight size={13} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}
export function LinkRow({
  title,
  detail,
  onPress,
  icon: Icon,
  tint,
}: {
  title: string;
  detail?: string;
  onPress: () => void;
  icon: LucideIcon;
  tint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        s.row,
        { paddingVertical: 13, gap: 14, borderRadius: 10 },
        pressed && { backgroundColor: colors.canvas },
      ]}
    >
      <View style={[s.iconBox, { backgroundColor: tint || colors.sky }]}>
        <Icon size={19} color={colors.text} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.text, { fontWeight: "500" }]}>{title}</Text>
        {detail && <Text style={s.small}>{detail}</Text>}
      </View>
      <ChevronRight size={15} color={colors.muted} />
    </Pressable>
  );
}
/** An original little sky pebble, drawn locally; no Meta artwork. */
export function Orb({ size = 42 }: { size?: number }) {
  return (
    <View accessibilityLabel="OpenMuse" style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 80 80">
        <Defs>
          <LinearGradient id="pebble" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#EDF8FF" />
            <Stop offset="0.55" stopColor="#C7E4F2" />
            <Stop offset="1" stopColor="#A2C7DA" />
          </LinearGradient>
          <LinearGradient id="face" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#FFFDF4" />
            <Stop offset="1" stopColor="#F2E7CE" />
          </LinearGradient>
        </Defs>
        <Ellipse cx="40" cy="72" rx="23" ry="4" fill="#132631" opacity="0.05" />
        <Path
          d="M17 42C13 20 27 8 42 10C60 9 66 26 63 43C64 53 70 57 66 64C59 77 20 77 14 63C11 57 17 50 17 42Z"
          fill="url(#pebble)"
        />
        <Path d="M24 26C29 17 51 17 57 28C63 43 51 53 40 53C26 53 17 41 24 26Z" fill="url(#face)" />
        <Ellipse cx="28" cy="39" rx="4" ry="2.5" fill="#ECC8BA" opacity="0.55" />
        <Ellipse cx="52" cy="39" rx="4" ry="2.5" fill="#ECC8BA" opacity="0.55" />
        <Circle cx="32" cy="34" r="1.7" fill="#283238" />
        <Circle cx="48" cy="34" r="1.7" fill="#283238" />
        <Path
          d="M37 40Q40 42 43 40"
          stroke="#A38D70"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
        />
        <Path d="M27 58Q40 64 54 57" stroke="#92BBCE" strokeWidth="1.2" fill="none" opacity="0.4" />
      </Svg>
    </View>
  );
}
export function dateLabel(value: string, options?: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", options || { month: "short", day: "numeric" });
}
export function timeLabel(value: string, timeZone?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}
export function relativeDate(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  return diff < 60_000
    ? "Just now"
    : diff < 3600_000
      ? `${Math.floor(diff / 60_000)}m ago`
      : diff < 86400_000
        ? `${Math.floor(diff / 3600_000)}h ago`
        : dateLabel(value);
}
