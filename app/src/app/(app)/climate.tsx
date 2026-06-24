import { climateStartKey } from "@/components/climate-control";
import { DurationField } from "@/components/duration-field";
import { IosButton } from "@/components/ios-list";
import { useThemeToggle } from "@/providers/theme-provider";
import { orpc } from "@/rpc";
import { Host, Stepper } from "@expo/ui/swift-ui";
import {
  disabled as disabledModifier,
  frame,
  offset,
  scaleEffect,
} from "@expo/ui/swift-ui/modifiers";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { H2, Paragraph, Spinner, Text, XStack, YStack } from "tamagui";

const TEMP_MIN = 60;
const TEMP_MAX = 85;
const DEFAULT_TEMP = 72;
const LONG_SESSION_MIN = 360; // >6h shows a battery caution

/**
 * The Start/Adjust climate form, presented as a native iOS form sheet (see the
 * `climate` screen options in `(app)/_layout.tsx`). It's a route rather than an
 * in-place component specifically so the sheet is a UIKit sheet: its native
 * drag-to-dismiss coordinates with the native SwiftUI time wheel inside, which
 * an RN-gesture-handler sheet can't (spinning the wheel dragged the sheet).
 *
 * The start command is fired under `climateStartKey` so the climate card can
 * mirror its in-flight/error state after this sheet closes — see ClimateControl.
 * Seeds come in as params: Adjust carries the live session's temp + end so
 * changing only the temp keeps the schedule; Start fetches the car's current
 * target temp and defaults the duration to 30m.
 */
export default function ClimateSheet() {
  const insets = useSafeAreaInsets();
  // The native stepper needs a resolved scheme to follow the in-app theme.
  const { pref } = useThemeToggle();
  const router = useRouter();
  const {
    uuid,
    mode,
    tempF: tempFParam,
    endMs: endMsParam,
  } = useLocalSearchParams<{
    uuid: string;
    mode?: string;
    tempF?: string;
    endMs?: string;
  }>();
  const adjust = mode === "adjust";

  const seededEndMs = adjust && endMsParam != null ? Number(endMsParam) : null;
  // Set when the user chose a wall-clock end time; minutes are recomputed from
  // it at submit so clock drift while the sheet sits open cancels out.
  const [endMs, setEndMs] = useState<number | null>(seededEndMs);
  const [durationMin, setDurationMin] = useState(() =>
    seededEndMs !== null
      ? Math.max(5, Math.round((seededEndMs - Date.now()) / 60000))
      : 30,
  );
  // null until the user adjusts the stepper; the shown temp otherwise derives
  // from the seed (the session's temp, or the car's current target).
  const [userTempF, setUserTempF] = useState<number | null>(null);

  // Start fetches the car's current target temp (plain access-token read, no
  // S-PIN); Adjust already carries it via params.
  const info = useQuery({
    ...orpc.vehicle.climateInfo.queryOptions({ input: { uuid } }),
    enabled: !adjust,
    staleTime: 60_000,
  });

  const startCmd = useMutation({
    ...orpc.vehicle.climateStart.mutationOptions(),
    mutationKey: climateStartKey(uuid),
    onSuccess: () => {
      router.back();
    },
  });

  // The seed (session's temp for Adjust, car's current setting for Start); null
  // while loading.
  const paramTempF = tempFParam != null ? Number(tempFParam) : null;
  const seedTempF = adjust
    ? paramTempF
    : (info.data?.targetTempF ?? (info.isError ? DEFAULT_TEMP : null));
  const tempReady = userTempF !== null || seedTempF !== null;
  const tempF = userTempF ?? seedTempF ?? DEFAULT_TEMP;

  return (
    // The sheet's surface colour comes from the form sheet's contentStyle (the
    // solid frosted-material grey set in (app)/_layout.tsx); this YStack stays
    // transparent. fitToContents sizes the sheet to it, so it must NOT be a
    // ScrollView (that measures as zero height).
    <YStack p="$4" pb={Math.max(insets.bottom, 16)} gap="$4">
      <Paragraph size="$6" fontWeight="700" color="$color">
        {adjust ? "Adjust climate" : "Start climate"}
      </Paragraph>

      {/* Temperature stepper */}
      <YStack gap="$2">
        <Paragraph color="$color10">Temperature</Paragraph>
        <XStack items="center" justify="space-between">
          {tempReady ? (
            <H2
              color="$color"
              fontVariant={["tabular-nums"]}
            >{`${String(tempF)}°F`}</H2>
          ) : (
            <Spinner color="$color10" />
          )}
          {/* Host, SwiftUI frame, and scaled visual are all EXACTLY
              127x44 (94x32 * 1.35): the hosting view doesn't center
              content in spare space, so any slack floats the control off
              the row's center — give it zero slack and let the RN row do
              the centering. */}
          <Host style={{ width: 127, height: 44 }} colorScheme={pref}>
            <Stepper
              label=""
              value={tempF}
              min={TEMP_MIN}
              max={TEMP_MAX}
              step={1}
              onValueChange={setUserTempF}
              // SwiftUI Steppers ignore controlSize, so scale to bring the
              // +/- buttons to ~44pt.
              modifiers={[
                scaleEffect(1.35),
                frame({ width: 127, height: 44 }),
                // Empirical: the bridge renders the scaled visual ~22pt
                // right of its frame; uncorrected, the "+" half leaves
                // the Host's hit-test bounds.
                offset({ x: -22.3 }),
                disabledModifier(!tempReady || startCmd.isPending),
              ]}
            />
          </Host>
        </XStack>
      </YStack>

      {/* Duration / end-time selection */}
      <YStack gap="$2">
        <Paragraph color="$color10">Keep on for</Paragraph>
        <DurationField
          value={durationMin}
          disabled={startCmd.isPending}
          includePresets={!adjust}
          {...(seededEndMs !== null ? { initialEndMs: seededEndMs } : {})}
          onChange={(min, end) => {
            setDurationMin(min);
            setEndMs(end ?? null);
          }}
        />
      </YStack>

      {durationMin > LONG_SESSION_MIN ? (
        <Paragraph color="$yellow10" fontSize="$2">
          Running climate for {String(Math.round(durationMin / 60))}h can
          significantly drain the high-voltage battery. Best done while plugged
          in.
        </Paragraph>
      ) : null}

      <IosButton
        full
        tone="blue"
        disabled={startCmd.isPending || !tempReady}
        onPress={() => {
          const effectiveMin =
            endMs !== null
              ? Math.min(
                  1440,
                  Math.max(5, Math.round((endMs - Date.now()) / 60000)),
                )
              : durationMin;
          startCmd.mutate({ uuid, tempF, durationMin: effectiveMin });
        }}
        label={startCmd.isPending ? "Starting…" : adjust ? "Update" : "Start"}
      />
      {startCmd.error ? (
        <Text selectable color="$red10" fontSize="$2">
          {startCmd.error.message}
        </Text>
      ) : null}
    </YStack>
  );
}
