import { useIosColors } from "@/ios-colors";
import type { SymbolViewProps } from "expo-symbols";
import { Children, Fragment, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { YStack, type GetProps } from "tamagui";
import { SfIcon } from "./sf-icon";

// Tamagui's color props are typed to theme tokens, so the Apple system colors
// (plain hex/rgba) go through RN's `style`/RN primitives, which accept color
// strings — and RN Text/Pressable also give us the System font and a native
// press highlight for free. IosCard stays a Tamagui YStack so callers can keep
// passing Tamagui props (p/gap).
type CardProps = Omit<GetProps<typeof YStack>, "children"> & {
  children?: ReactNode;
};

/**
 * iOS "insetGrouped" surface: a rounded card filled with the secondary grouped
 * background. Wraps both a group of rows (IosGroup) and the dashboard's control
 * cards, so the whole screen reads as one grouped table.
 */
export function IosCard({ children, ...rest }: CardProps) {
  const c = useIosColors();
  return (
    <YStack
      rounded={10}
      overflow="hidden"
      style={{ backgroundColor: c.card }}
      {...rest}
    >
      {children}
    </YStack>
  );
}

/**
 * An IosCard that draws hairline separators between its children, inset from the
 * leading edge as iOS does. Pass IosRow children.
 */
export function IosGroup({
  children,
  separatorInset = 16,
  ...rest
}: CardProps & { separatorInset?: number }) {
  const c = useIosColors();
  const items = Children.toArray(children);
  return (
    <IosCard {...rest}>
      {items.map((child, i) => (
        <Fragment key={i}>
          {child}
          {i < items.length - 1 ? (
            <View
              style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: c.separator,
                marginLeft: separatorInset,
              }}
            />
          ) : null}
        </Fragment>
      ))}
    </IosCard>
  );
}

/** Uppercase grouped-section header (footnote, secondary) placed above a group. */
export function IosSectionHeader({ children }: { children: string }) {
  const c = useIosColors();
  return (
    <Text
      style={{
        fontSize: 13,
        color: c.secondaryLabel,
        marginLeft: 16,
        marginBottom: 6,
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * A grouped-list cell — the workhorse for every native row. Supports a leading
 * SF icon (or custom `leading`), a title with optional `subtitle`, a trailing
 * `value` (+ optional `subValue`), a custom trailing `accessory` (e.g. a native
 * Toggle), and `onPress` (which adds the disclosure chevron + full-row press
 * highlight, like a UIKit cell).
 */
export function IosRow({
  label,
  subtitle,
  icon,
  iconColor,
  leading,
  value,
  subValue,
  valueColor,
  warn,
  accessory,
  multiline,
  onPress,
}: {
  label: string;
  subtitle?: string | undefined;
  icon?: SymbolViewProps["name"] | undefined;
  iconColor?: string | undefined;
  leading?: ReactNode | undefined;
  value?: string | undefined;
  subValue?: string | undefined;
  valueColor?: string | undefined;
  warn?: boolean | undefined;
  accessory?: ReactNode | undefined;
  multiline?: boolean | undefined;
  onPress?: (() => void) | undefined;
}) {
  const c = useIosColors();
  const lead =
    leading ??
    (icon !== undefined ? (
      <SfIcon name={icon} size={22} color={iconColor ?? c.secondaryLabel} />
    ) : null);
  const content = (
    <View
      style={{
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 11,
        gap: 12,
      }}
    >
      {lead}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{ fontSize: 17, color: c.label }}
          numberOfLines={multiline === true ? undefined : 1}
        >
          {label}
        </Text>
        {subtitle !== undefined && subtitle !== "" ? (
          <Text
            style={{ fontSize: 15, color: c.secondaryLabel }}
            numberOfLines={multiline === true ? undefined : 2}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {accessory ?? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {value !== undefined ? (
            <View style={{ alignItems: "flex-end" }}>
              <Text
                style={{
                  fontSize: 17,
                  color:
                    warn === true ? c.warn : (valueColor ?? c.secondaryLabel),
                  textAlign: "right",
                }}
              >
                {value}
              </Text>
              {subValue !== undefined ? (
                <Text
                  style={{
                    fontSize: 13,
                    color: c.secondaryLabel,
                    textAlign: "right",
                  }}
                >
                  {subValue}
                </Text>
              ) : null}
            </View>
          ) : null}
          {onPress !== undefined ? (
            <SfIcon name="chevron.right" size={14} color={c.chevron} />
          ) : null}
        </View>
      )}
    </View>
  );
  if (onPress === undefined) return content;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) =>
        pressed ? { backgroundColor: c.selection } : null
      }
    >
      {content}
    </Pressable>
  );
}

/**
 * A native-style iOS button. `filled` (default) is a solid systemBlue/Red/Green
 * fill with white text; `tinted`/`plain` are accent-colored text with no fill.
 * `full` makes it a full-width, taller primary button (login / sheet / refresh).
 * Renders consistently in light and dark — unlike Tamagui's accent-theme
 * buttons, which go pale and low-contrast in light mode.
 */
export function IosButton({
  label,
  onPress,
  tone = "blue",
  variant = "filled",
  icon,
  disabled,
  full,
}: {
  label: string;
  onPress: () => void;
  tone?: "blue" | "red" | "green";
  variant?: "filled" | "tinted" | "plain";
  icon?: SymbolViewProps["name"];
  disabled?: boolean;
  full?: boolean;
}) {
  const c = useIosColors();
  const accent = tone === "red" ? c.red : tone === "green" ? c.green : c.blue;
  const filled = variant === "filled";
  const fg = filled ? "#FFFFFF" : accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        backgroundColor: filled ? accent : "transparent",
        paddingHorizontal: variant === "plain" ? 4 : 16,
        paddingVertical: full === true ? 13 : 9,
        borderRadius: full === true ? 12 : 9,
        alignSelf: full === true ? "stretch" : "flex-start",
        opacity: disabled === true ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      {icon !== undefined ? (
        <SfIcon name={icon} size={full === true ? 18 : 16} color={fg} />
      ) : null}
      <Text
        style={{
          color: fg,
          fontSize: full === true ? 17 : 16,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
