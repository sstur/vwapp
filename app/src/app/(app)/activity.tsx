import { snapshotUpdates, type UpdateEvent } from "@/activity-events";
import { IosGroup, IosRow } from "@/components/ios-list";
import { db } from "@/db";
import { orpc } from "@/rpc";
import { useQuery } from "@tanstack/react-query";
import type { ActivityEventDTO } from "@vwapp/contract";
import { Stack } from "expo-router";
import { RefreshControl, ScrollView } from "react-native";
import { Paragraph, Spinner, Text, useTheme } from "tamagui";

/** How many stored snapshots to diff for data-update events. */
const SNAPSHOT_WINDOW = 500;

/**
 * Recent vehicle activity: VW's own event log (remote command requests) is
 * only half the story, so it's merged with data-update events diffed from our
 * stored snapshots (lock/doors/windows/plug/charging — what the car did on
 * its own). The snapshots arrive via live query, so updates stream in without
 * a refresh.
 */
export default function ActivityScreen() {
  // Native RefreshControl needs a resolved color string, not a Tamagui token.
  const theme = useTheme();
  const query = useQuery(orpc.vehicle.activity.queryOptions({ input: {} }));

  const vehiclesQuery = db.useQuery({ vehicles: {} });
  const vehicle = vehiclesQuery.data?.vehicles[0];
  const snapshotsQuery = db.useQuery(
    vehicle === undefined
      ? null
      : {
          snapshots: {
            $: {
              where: { "vehicle.id": vehicle.id },
              order: { createdAt: "desc" },
              limit: SNAPSHOT_WINDOW,
            },
          },
        },
  );

  const events = mergeEvents(
    query.data?.events ?? [],
    snapshotUpdates(snapshotsQuery.data?.snapshots ?? []),
  );

  // A skipped (null) query reports isLoading forever — only consult the
  // snapshot query once there's a vehicle and it actually runs.
  const isPending =
    query.isPending ||
    vehiclesQuery.isLoading ||
    (vehicle !== undefined && snapshotsQuery.isLoading);
  const errorMessage = (
    query.error ??
    vehiclesQuery.error ??
    snapshotsQuery.error
  )?.message;

  return (
    <>
      <Stack.Screen options={{ title: "Activity", headerBackTitle: "Home" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => {
              void query.refetch();
            }}
            tintColor={theme.color.val}
          />
        }
      >
        {isPending ? <Spinner color="$color" /> : null}
        {errorMessage !== undefined ? (
          <Text selectable color="$red10">
            {errorMessage}
          </Text>
        ) : null}
        {!isPending && errorMessage === undefined && events.length === 0 ? (
          <Paragraph color="$color10">No recent activity.</Paragraph>
        ) : null}
        {events.length > 0 ? (
          <IosGroup>
            {events.map((e, i) => (
              <ActivityRow key={`${String(e.at)}-${String(i)}`} e={e} />
            ))}
          </IosGroup>
        ) : null}
      </ScrollView>
    </>
  );
}

interface Row {
  at: number | null;
  title: string;
  description: string | null;
  icon: UpdateEvent["icon"];
}

/** Both sources in one stream, newest first (VW events without a time sink). */
function mergeEvents(
  vwEvents: ActivityEventDTO[],
  updates: UpdateEvent[],
): Row[] {
  const rows: Row[] = [
    ...vwEvents.map((e) => ({
      at: e.at,
      title: e.title,
      description: e.description,
      icon: iconForVwType(e.type),
    })),
    ...updates,
  ];
  return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

function iconForVwType(type: string | null): Row["icon"] {
  switch (type) {
    case "Trip":
      return "location.fill";
    case "Alert":
      return "exclamationmark.triangle.fill";
    case "Commands":
      return "bolt.fill";
    default:
      return "bell.fill";
  }
}

function ActivityRow({ e }: { e: Row }) {
  return (
    <IosRow
      icon={e.icon}
      label={e.title}
      subtitle={e.description ?? undefined}
      value={e.at != null ? formatWhen(e.at) : undefined}
      multiline
    />
  );
}

function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
