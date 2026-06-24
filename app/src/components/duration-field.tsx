import { SfIcon } from "@/components/sf-icon";
import { useIosColors } from "@/ios-colors";
import { useThemeToggle } from "@/providers/theme-provider";
import { DatePicker, Host, Stepper } from "@expo/ui/swift-ui";
import {
  datePickerStyle,
  disabled as disabledModifier,
  frame,
  offset,
  scaleEffect,
} from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import { Button, H2, Paragraph, XStack, YStack } from "tamagui";

const PRESETS = [
  { label: "30m", min: 30 },
  { label: "1h", min: 60 },
  { label: "2h", min: 120 },
  { label: "4h", min: 240 },
  { label: "8h", min: 480 },
];

const DURATION_MIN = 15;
const DURATION_MAX = 1440; // 24 h — matches the contract's max
const DURATION_STEP = 15;
// Standard UIPickerView height; the Host needs an explicit size so the sheet's
// fit measurement never races the native view's own layout.
const WHEEL_HEIGHT = 216;

type Tab = "duration" | "end";
type View = "chips" | "picker" | "pill";
type Committed =
  | { kind: "duration"; min: number }
  | { kind: "end"; endMs: number };
interface EndParts {
  hour: number;
  minute: number;
}

/**
 * "Keep on for" field: preset chips plus a More… picker offering a custom
 * duration (15-min steps) or a wall-clock end time (native wheel, resolved to
 * its next occurrence — always <24 h away, so a time alone is unambiguous and
 * no date entry is needed). Emits effective minutes; when the user picked an
 * end time it also emits `endMs` so the caller can recompute minutes at
 * submit time (cancels clock drift while the sheet sits open).
 *
 * `includePresets={false}` (the Adjust flow) renders just the picker, opened
 * on the end-time tab seeded from `initialEndMs`, and emits on every change
 * instead of on Use.
 */
export function DurationField({
  value,
  onChange,
  includePresets = true,
  initialEndMs,
  disabled = false,
}: {
  value: number;
  onChange: (durationMin: number, endMs?: number) => void;
  includePresets?: boolean;
  initialEndMs?: number;
  /** Freezes every control (chips, tabs, wheel, stepper) — e.g. mid-submit. */
  disabled?: boolean;
}) {
  const live = !includePresets;
  // The native wheel needs a resolved scheme so it follows the in-app theme
  // override rather than the system appearance.
  const { pref } = useThemeToggle();
  const c = useIosColors();
  // iOS system-blue fill for selected/primary buttons. The app drives button
  // blue through ios-colors (c.blue, via IosButton) — Tamagui's `theme="blue"`
  // is a different hue AND gives dark label text in light mode. So set the fill
  // and white label explicitly (white in both themes, like IosButton). pressStyle
  // pins the fill so press doesn't flash a themed grey.
  const blueFill = {
    backgroundColor: c.blue,
    color: "white" as const,
    pressStyle: { backgroundColor: c.blue, opacity: 0.85 },
  };
  const [view, setView] = useState<View>(includePresets ? "chips" : "picker");
  const [committed, setCommitted] = useState<Committed | null>(null);
  const [tab, setTab] = useState<Tab>(
    initialEndMs === undefined ? "duration" : "end",
  );
  const [pickMin, setPickMin] = useState(() => clampSeed(value));
  const [endParts, setEndParts] = useState<EndParts>(() =>
    initialEndMs !== undefined
      ? toParts(initialEndMs)
      : partsInMinutes(Math.max(value, DURATION_MIN)),
  );

  const endMs = nextOccurrence(endParts.hour, endParts.minute);

  const emitEnd = (ms: number) => {
    onChange(Math.max(5, minutesUntil(ms)), ms);
  };

  // Snap to the next/previous quarter-hour mark rather than adding ±15: the seed
  // can sit off-grid (Adjust seeds the exact remaining minutes), and stepping
  // from there should land on pretty times, not drag the offset along.
  const stepDuration = (dir: 1 | -1) => {
    const next =
      dir === 1
        ? Math.min(
            DURATION_MAX,
            (Math.floor(pickMin / DURATION_STEP) + 1) * DURATION_STEP,
          )
        : Math.max(
            DURATION_MIN,
            (Math.ceil(pickMin / DURATION_STEP) - 1) * DURATION_STEP,
          );
    setPickMin(next);
    if (live) onChange(next);
  };

  const updateParts = (next: EndParts) => {
    setEndParts(next);
    if (live) emitEnd(nextOccurrence(next.hour, next.minute));
  };

  // Entering the custom picker from the presets: seed both representations from
  // the selected preset, so "More…" continues from it instead of showing a
  // stale default (tapping 30m then More… used to jump back to 1h).
  const openPicker = () => {
    const mins = clampSeed(value);
    setPickMin(mins);
    setEndParts(partsInMinutes(mins));
    setView("picker");
  };

  // Carry the current selection across when switching tabs, so Duration and
  // End time always describe the same span (dialing 15m then tapping End time
  // shouldn't snap back to 1h-from-now). Seed locally and emit that — setState
  // hasn't applied yet this tick.
  const switchTab = (next: Tab) => {
    if (next === "end") {
      const seeded = partsInMinutes(pickMin);
      setEndParts(seeded);
      setTab("end");
      if (live) emitEnd(nextOccurrence(seeded.hour, seeded.minute));
    } else {
      const mins = clampSeed(minutesUntil(endMs));
      setPickMin(mins);
      setTab("duration");
      if (live) onChange(mins);
    }
  };

  const use = () => {
    if (tab === "duration") {
      setCommitted({ kind: "duration", min: pickMin });
      onChange(pickMin);
    } else {
      setCommitted({ kind: "end", endMs });
      emitEnd(endMs);
    }
    setView("pill");
  };

  const reopenPicker = () => {
    if (committed?.kind === "duration") {
      setTab("duration");
      setPickMin(committed.min);
    } else if (committed?.kind === "end") {
      setTab("end");
      setEndParts(toParts(committed.endMs));
    }
    setView("picker");
  };

  const backToPresets = () => {
    setCommitted(null);
    onChange(value); // keep the minutes, drop the end-time association
    setView("chips");
  };

  if (view === "chips") {
    return (
      <XStack gap="$2" flexWrap="wrap">
        {/* px=0: six equal-width chips leave ~54pt each on a 390pt screen —
            the Button's default horizontal padding squeezes the label into
            truncation ("3...") before the text itself is anywhere near
            overflow. */}
        {PRESETS.map((d) => (
          <Button
            key={d.min}
            size="$4"
            flex={1}
            px={0}
            disabled={disabled}
            {...(value === d.min ? blueFill : {})}
            onPress={() => {
              onChange(d.min);
            }}
          >
            {d.label}
          </Button>
        ))}
        {/* Icon, not "More…": the text squeezed to truncation in its ~54pt
            slot. The ellipsis is iOS's standard "more options" affordance. */}
        <Button
          size="$4"
          flex={1}
          px={0}
          disabled={disabled}
          onPress={openPicker}
          accessibilityLabel="More duration options"
        >
          <SfIcon name="ellipsis" size={20} />
        </Button>
      </XStack>
    );
  }

  if (view === "pill" && committed !== null) {
    const label =
      committed.kind === "duration"
        ? fmtDuration(committed.min)
        : `${fmtUntil(committed.endMs)} · in ${fmtDuration(minutesUntil(committed.endMs))}`;
    return (
      <YStack gap="$2">
        <Button
          size="$4"
          {...blueFill}
          disabled={disabled}
          onPress={reopenPicker}
        >
          {label}
        </Button>
        <XStack gap="$2">
          <Button
            flex={1}
            size="$3"
            chromeless
            disabled={disabled}
            onPress={reopenPicker}
          >
            Change
          </Button>
          <Button
            flex={1}
            size="$3"
            chromeless
            disabled={disabled}
            onPress={backToPresets}
          >
            ‹ Presets
          </Button>
        </XStack>
      </YStack>
    );
  }

  return (
    <YStack gap="$3">
      <XStack gap="$2">
        <Button
          flex={1}
          size="$3"
          disabled={disabled}
          {...(tab === "duration" ? blueFill : {})}
          onPress={() => {
            switchTab("duration");
          }}
        >
          Duration
        </Button>
        <Button
          flex={1}
          size="$3"
          disabled={disabled}
          {...(tab === "end" ? blueFill : {})}
          onPress={() => {
            switchTab("end");
          }}
        >
          End time
        </Button>
      </XStack>

      {tab === "duration" ? (
        <XStack items="center" justify="space-between">
          <YStack>
            <H2 color="$color" fontVariant={["tabular-nums"]}>
              {fmtDuration(pickMin)}
            </H2>
            <Paragraph color="$color10" fontSize="$2">
              {fmtDurationEnd(pickMin)}
            </Paragraph>
          </YStack>
          {/* Only the direction is taken from the native stepper; the snap
              logic in stepDuration keeps off-grid seeds landing on pretty
              times instead of dragging their offset along. */}
          {/* Host, SwiftUI frame, and scaled visual are all EXACTLY 127x44
              (94x32 * 1.35): the hosting view doesn't center content in
              spare space, so any slack floats the control off the row's
              center — give it zero slack and let the RN row do the
              centering. */}
          <Host style={{ width: 127, height: 44 }} colorScheme={pref}>
            <Stepper
              label=""
              value={pickMin}
              min={DURATION_MIN}
              max={DURATION_MAX}
              step={DURATION_STEP}
              onValueChange={(next) => {
                stepDuration(next > pickMin ? 1 : -1);
              }}
              // SwiftUI Steppers ignore controlSize, so scale to bring the
              // +/- buttons to ~44pt.
              modifiers={[
                scaleEffect(1.35),
                frame({ width: 127, height: 44 }),
                // Empirical: the bridge renders the scaled visual ~22pt
                // right of its frame; uncorrected, the "+" half leaves
                // the Host's hit-test bounds.
                offset({ x: -22.3 }),
                disabledModifier(disabled),
              ]}
            />
          </Host>
        </XStack>
      ) : (
        <YStack gap="$2">
          <Host style={{ height: WHEEL_HEIGHT }} colorScheme={pref}>
            <DatePicker
              selection={new Date(endMs)}
              displayedComponents={["hourAndMinute"]}
              modifiers={[datePickerStyle("wheel"), disabledModifier(disabled)]}
              onDateChange={(date) => {
                updateParts({
                  hour: date.getHours(),
                  minute: date.getMinutes(),
                });
              }}
            />
          </Host>
          <YStack items="center">
            <Paragraph color="$color">{fmtEndLabel(endMs)}</Paragraph>
            <Paragraph
              color="$color10"
              fontSize="$2"
            >{`in ${fmtDuration(minutesUntil(endMs))}`}</Paragraph>
          </YStack>
        </YStack>
      )}

      {includePresets ? (
        <XStack gap="$2">
          <Button
            flex={1}
            size="$4"
            chromeless
            disabled={disabled}
            onPress={() => {
              setView(committed === null ? "chips" : "pill");
            }}
          >
            Cancel
          </Button>
          <Button
            flex={1}
            size="$4"
            {...blueFill}
            disabled={disabled}
            onPress={use}
          >
            Use
          </Button>
        </XStack>
      ) : null}
    </YStack>
  );
}

function toParts(ms: number): EndParts {
  const d = new Date(ms);
  return { hour: d.getHours(), minute: d.getMinutes() };
}

/** Wall-clock EndParts for a time `mins` from now. */
function partsInMinutes(mins: number): EndParts {
  return toParts(Date.now() + mins * 60000);
}

/** Clamp a minutes value into the pickable range (matches the contract's 5m floor). */
function clampSeed(mins: number): number {
  return Math.min(DURATION_MAX, Math.max(5, mins));
}

/** The next time the wall clock reads hour:minute — today if still ahead, else tomorrow. */
function nextOccurrence(hour: number, minute: number): number {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function minutesUntil(ms: number): number {
  return Math.max(0, Math.round((ms - Date.now()) / 60000));
}

function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${String(m)}m`;
  if (m === 0) return `${String(h)}h`;
  return `${String(h)}h ${String(m)}m`;
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function isToday(ms: number): boolean {
  const d = new Date(ms);
  const now = new Date();
  return (
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear()
  );
}

function fmtEndLabel(ms: number): string {
  return `${isToday(ms) ? "Today" : "Tomorrow"} at ${fmtClock(ms)}`;
}

/** Where a duration starting now would end, as an end-label. */
function fmtDurationEnd(min: number): string {
  return fmtEndLabel(Date.now() + min * 60000);
}

function fmtUntil(ms: number): string {
  return isToday(ms)
    ? `Until ${fmtClock(ms)}`
    : `Until tomorrow at ${fmtClock(ms)}`;
}
