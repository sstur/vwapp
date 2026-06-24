import { IosButton, IosGroup, IosRow } from "@/components/ios-list";
import { db } from "@/db";
import { agoLabel, useNow } from "@/hooks/use-now";
import { useIosColors } from "@/ios-colors";
import { orpc } from "@/rpc";
import { useMutation } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { ScrollView } from "react-native";
import { Paragraph, Spinner, Text } from "tamagui";

/**
 * What "Updated" means, a manual refresh (wake) button, and the per-category
 * update times VW reports alongside the data.
 */
export default function UpdatesScreen() {
  const now = useNow();
  const ios = useIosColors();
  // Same live-query pair as the dashboard: the refreshed status lands here
  // through the snapshot subscription, not the RPC result.
  const vehiclesQuery = db.useQuery({ vehicles: {} });
  const vehicle = vehiclesQuery.data?.vehicles[0];
  const snapshotQuery = db.useQuery(
    vehicle === undefined
      ? null
      : {
          snapshots: {
            $: {
              where: { "vehicle.id": vehicle.id },
              order: { createdAt: "desc" },
              limit: 1,
            },
          },
        },
  );
  const snapshot = snapshotQuery.data?.snapshots[0];
  // A skipped (null) query reports isLoading forever — only consult it once
  // there's a vehicle and the query actually runs.
  const isLoading =
    vehiclesQuery.isLoading ||
    (vehicle !== undefined && snapshotQuery.isLoading);

  const refresh = useMutation(orpc.vehicle.refresh.mutationOptions());
  const errorMessage = (
    vehiclesQuery.error ??
    snapshotQuery.error ??
    refresh.error
  )?.message;

  return (
    <>
      <Stack.Screen
        options={{ title: "Status updates", headerBackTitle: "Home" }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
        <Paragraph
          style={{ color: ios.secondaryLabel, fontSize: 15, lineHeight: 20 }}
        >
          “Updated” is when your car last checked in with VW — automatic, about
          once a minute. Refreshing also wakes the car, so fresh numbers may
          keep arriving for a few minutes.
        </Paragraph>

        <IosButton
          full
          tone="blue"
          icon="arrow.clockwise"
          disabled={refresh.isPending}
          onPress={() => {
            refresh.mutate({});
          }}
          label={refresh.isPending ? "Refreshing…" : "Refresh now"}
        />

        {isLoading ? (
          <Spinner
            color="$color"
            transition="quick"
            enterStyle={{ opacity: 0 }}
          />
        ) : null}
        {errorMessage != null ? (
          <Text selectable color="$red10">
            {errorMessage}
          </Text>
        ) : null}

        {snapshot !== undefined ? (
          <IosGroup>
            <WhenRow
              label="Car check-in"
              at={snapshot.capturedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Vehicle status"
              at={snapshot.rvsUpdatedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Doors"
              at={snapshot.doorsUpdatedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Locks"
              at={snapshot.locksUpdatedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Windows"
              at={snapshot.windowsUpdatedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Battery & charging"
              at={snapshot.chargeUpdatedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Parked location"
              at={snapshot.parkedAt ?? null}
              now={now}
            />
            <WhenRow
              label="Received by server"
              at={snapshot.createdAt}
              now={now}
            />
          </IosGroup>
        ) : !isLoading && errorMessage == null ? (
          <Paragraph color="$color10">No status stored yet.</Paragraph>
        ) : null}
      </ScrollView>
    </>
  );
}

/** Category + when it last updated: absolute clock time, relative underneath. */
function WhenRow({
  label,
  at,
  now,
}: {
  label: string;
  at: number | null;
  now: number;
}) {
  if (at === null) return <IosRow label={label} value="—" />;
  return (
    <IosRow
      label={label}
      value={clockLabel(at, now)}
      subValue={agoLabel(at, now)}
    />
  );
}

/** "8:40 PM" today; otherwise prefixed with the day ("Jun 9, 8:40 PM"). */
function clockLabel(epochMs: number, now: number): string {
  const d = new Date(epochMs);
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
