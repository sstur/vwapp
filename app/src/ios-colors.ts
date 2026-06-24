/**
 * Apple's semantic system colors for the grouped-list look (insetGrouped table),
 * hardcoded for light and dark. We can't use RN `PlatformColor` here: it tracks
 * the OS appearance, but this app has an in-app light/dark override (see
 * theme-provider) that the OS — and Expo Go — ignore. So these are switched by
 * the in-app `pref` instead, via useIosColors().
 *
 * Values are the documented iOS system colors:
 *   systemGroupedBackground / secondarySystemGroupedBackground / separator /
 *   label / secondaryLabel / systemGray3 (chevron) / systemGray4 (selection).
 */
import { useThemeToggle } from "@/providers/theme-provider";

export interface IosColors {
  /** Screen background behind the cards (insetGrouped tables). */
  groupedBg: string;
  /** Plain (non-grouped) background — systemBackground: white / black. Used by
   *  full-bleed plain lists like the iMessage-style message center. */
  systemBackground: string;
  /** Elevated sheet surface — a solid stand-in for iOS's systemMaterial frosted
   *  glass, used by the climate form sheet. */
  sheet: string;
  /** Card (cell) fill. */
  card: string;
  /** Hairline row separator. */
  separator: string;
  /** Primary text. */
  label: string;
  /** Secondary/value text. */
  secondaryLabel: string;
  /** Disclosure chevron. */
  chevron: string;
  /** Cell highlight on press. */
  selection: string;
  /** Warning value text (e.g. a door left open). */
  warn: string;
  /** Filled-button tints (systemBlue/Red/Green); text on them is white. */
  blue: string;
  red: string;
  green: string;
}

const light: IosColors = {
  groupedBg: "#F2F2F7",
  systemBackground: "#FFFFFF",
  sheet: "#F2F2F7",
  card: "#FFFFFF",
  separator: "#C6C6C8",
  label: "#000000",
  secondaryLabel: "rgba(60,60,67,0.6)",
  chevron: "#C7C7CC",
  selection: "#D1D1D6",
  warn: "#C04C00",
  blue: "#007AFF",
  red: "#FF3B30",
  green: "#34C759",
};

const dark: IosColors = {
  groupedBg: "#000000",
  systemBackground: "#000000",
  sheet: "#2C2C2E",
  card: "#1C1C1E",
  separator: "#38383A",
  label: "#FFFFFF",
  secondaryLabel: "rgba(235,235,245,0.6)",
  chevron: "#5B5B5F",
  selection: "#3A3A3C",
  warn: "#FF9F0A",
  blue: "#0A84FF",
  red: "#FF453A",
  green: "#30D158",
};

export function useIosColors(): IosColors {
  const { pref } = useThemeToggle();
  return pref === "dark" ? dark : light;
}
