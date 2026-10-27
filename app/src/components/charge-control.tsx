import { useTransientError } from "@/hooks/use-transient-error";
import { useThemeToggle } from "@/providers/theme-provider";
import { orpc } from "@/rpc";
import { formatMiles } from "@/units";
import { Gauge, Host, Text as NativeText, Picker } from "@expo/ui/swift-ui";
import {
  disabled as disabledModifier,
  gaugeStyle,
  pickerStyle,
  tag,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { InstaQLEntity } from "@instantdb/react-native";
import { useMutation } from "@tanstack/react-query";
import type { AppSchema } from "@vwapp/db";
import {
  AnimatePresence,
  H2,
  Paragraph,
  Spinner,
  Text,
  useTheme,
  XStack,
  YStack,
} from "tamagui";
import { IosButton, IosCard } from "./ios-list";
import { SfIcon } from "./sf-icon";

type Snapshot = InstaQLEntity<AppSchema, "snapshots">;

const LIMITS = [50, 60, 70, 80, 90, 100];

/**
 * Battery + charging card (the dashboard headline): SoC and range up top,
 * then the live charging status with its start/stop action inline (compact,
 * S-PIN-gated server-side — Stop only while actively charging, Charge only
 * when plugged in and idle). The charge limit is a native menu picker: one
 * deliberate selection commits one RPC, so VW's rate-limited EV channel sees
 * no more traffic than the old stepper's explicit Save did.
 */
export function ChargeControl({ s, uuid }: { s: Snapshot; uuid: string }) {
  // The native picker/gauge need a resolved scheme to follow the in-app theme.
  const { pref } = useThemeToggle();
  const theme = useTheme();
  const start = useMutation(orpc.vehicle.chargeStart.mutationOptions());
  const stop = useMutation(orpc.vehicle.chargeStop.mutationOptions());
  // The saved value arrives via the snapshot live query (the RPC writes a
  // fresh snapshot before resolving), so the row tracks the car.
  const setLimit = useMutation(orpc.vehicle.setChargeLimit.mutationOptions());

  const carLimit = s.targetSoc ?? null;
  // The car can report an off-grid limit (set from its own screen); without a
  // matching tag the menu's label would render blank.
  const limitOptions =
    carLimit === null || LIMITS.includes(carLimit)
      ? LIMITS
      : [carLimit, ...LIMITS];

  const charging = isCharging(s);
  // Can start only when plugged in and not already charging.
  const canStart = s.pluggedIn === true && !charging;
  const error = useTransientError(start.error ?? stop.error ?? setLimit.error);

  return (
    <IosCard p="$4" gap="$3.5">
      {/* Battery headline */}
      <YStack gap="$2">
        <YStack>
          <H2 color="$color">{s.soc != null ? `${String(s.soc)}%` : "—"}</H2>
          <Paragraph color="$color10">
            Battery
            {s.rangeKm != null ? ` · ${formatMiles(s.rangeKm)} range` : ""}
          </Paragraph>
        </YStack>
        {s.soc != null ? (
          <Host matchContents={{ vertical: true }} colorScheme={pref}>
            <Gauge
              value={s.soc / 100}
              modifiers={[
                gaugeStyle("linearCapacity"),
                // Green while charging, red when low — like the system battery.
                tint(
                  charging
                    ? theme.green10.val
                    : s.soc <= 20
                      ? theme.red10.val
                      : theme.blue10.val,
                ),
              ]}
            />
          </Host>
        ) : null}
      </YStack>

      {/* Charging status, with its action inline */}
      <XStack items="center" gap="$3">
        {charging ? (
          <SfIcon name="bolt.car.fill" color="$green10" size={26} />
        ) : (
          <SfIcon name="ev.charger.fill" color="$color10" size={26} />
        )}
        <YStack flex={1}>
          <Paragraph color={charging ? "$green10" : "$color"} fontWeight="700">
            {stateLabel(s)}
          </Paragraph>
          <Paragraph color="$color10" fontSize="$2">
            {plugLabel(s)}
          </Paragraph>
        </YStack>
        {charging ? (
          <IosButton
            tone="red"
            disabled={stop.isPending}
            onPress={() => {
              stop.mutate({ uuid });
            }}
            label={stop.isPending ? "Stopping…" : "Stop"}
          />
        ) : canStart ? (
          <IosButton
            tone="green"
            icon="bolt.car.fill"
            disabled={start.isPending}
            onPress={() => {
              start.mutate({ uuid });
            }}
            label={start.isPending ? "Starting…" : "Charge"}
          />
        ) : null}
      </XStack>

      {/* Charge limit: a native dropdown menu; selecting a value commits it. */}
      <XStack items="center" justify="space-between">
        <Paragraph color="$color10">Charge limit</Paragraph>
        <XStack items="center" gap="$2">
          {setLimit.isPending ? <Spinner color="$color10" /> : null}
          {carLimit !== null ? (
            <Host matchContents colorScheme={pref}>
              <Picker
                selection={carLimit}
                onSelectionChange={(next) => {
                  if (next !== carLimit && !setLimit.isPending) {
                    setLimit.mutate({ uuid, targetSoc: next });
                  }
                }}
                modifiers={[
                  pickerStyle("menu"),
                  disabledModifier(setLimit.isPending),
                ]}
              >
                {limitOptions.map((v) => (
                  <NativeText key={v} modifiers={[tag(v)]}>
                    {`${String(v)}%`}
                  </NativeText>
                ))}
              </Picker>
            </Host>
          ) : (
            <Paragraph color="$color" fontWeight="700">
              —
            </Paragraph>
          )}
        </XStack>
      </XStack>

      <AnimatePresence>
        {error ? (
          <Text
            key="charge-error"
            selectable
            color="$red10"
            fontSize="$2"
            transition="quick"
            animateOnly={["opacity"]}
            enterStyle={{ opacity: 0 }}
            exitStyle={{ opacity: 0 }}
          >
            {error.message}
          </Text>
        ) : null}
      </AnimatePresence>
    </IosCard>
  );
}

function isCharging(s: Snapshot): boolean {
  if (s.chargeState == null) return false;
  // Active charging only. VW's idle, target-reached states can END in "Charging"
  // (e.g. "chargePurposeReachedAndNotConservationCharging"), so matching the
  // substring flips an idle car to "Charging" between polls — the actively
  // charging states START with "charging".
  return s.chargeState.toLowerCase().startsWith("charging");
}

function stateLabel(s: Snapshot): string {
  if (s.chargeState == null) return "—";
  if (!isCharging(s))
    return s.pluggedIn === true ? "Plugged in, idle" : "Not charging";
  const power =
    s.chargePowerKw != null && s.chargePowerKw > 0
      ? ` ${String(s.chargePowerKw)} kW`
      : "";
  // minutesToFull is whole minutes, so <1m arrives as 0 and drops the estimate.
  const eta =
    s.minutesToFull != null && s.minutesToFull > 0
      ? ` · ${fmtEta(s.minutesToFull)} to full`
      : "";
  return `Charging${power}${eta}`;
}

/** "42m" under an hour (the rounded hour would read 0h/0.1h), "1.5h" above. */
function fmtEta(minutes: number): string {
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.round((minutes / 60) * 10) / 10)}h`;
}

function plugLabel(s: Snapshot): string {
  if (s.pluggedIn == null) return "Plug status unknown";
  if (!s.pluggedIn) return "Unplugged";
  return s.plugLocked === true ? "Connected · locked" : "Connected";
}
