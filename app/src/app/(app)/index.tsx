import { openSummary, strArr, unlockedSummary } from "@/closures";
import { ChargeControl } from "@/components/charge-control";
import { ClimateControl } from "@/components/climate-control";
import { IosButton, IosCard, IosGroup, IosRow } from "@/components/ios-list";
import { LockControl } from "@/components/lock-control";
import { VoiceControl } from "@/components/voice-control";
import { db } from "@/db";
import { agoLabel, useNow } from "@/hooks/use-now";
import { useTransientError } from "@/hooks/use-transient-error";
import { useIosColors } from "@/ios-colors";
import { useSession } from "@/providers/session-provider";
import { orpc } from "@/rpc";
import { formatMiles } from "@/units";
import type { InstaQLEntity } from "@instantdb/react-native";
import { useMutation } from "@tanstack/react-query";
import type { AppSchema } from "@vwapp/db";
import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView } from "react-native";
import {
  AnimatePresence,
  Paragraph,
  Spinner,
  Text,
  useTheme,
  YStack,
} from "tamagui";

type Snapshot = InstaQLEntity<AppSchema, "snapshots">;

export default function Dashboard() {
  const theme = useTheme();
  const ios = useIosColors();
  const router = useRouter();
  const { signOut, signOutError } = useSession();

  // Live queries: the Worker (pull-to-refresh or its cron) writes snapshots
  // to InstantDB and they stream in here — no polling, no invalidation.
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

  // Asks the Worker to fetch from VW right now; the result arrives through
  // the snapshot subscription above.
  const refresh = useMutation(orpc.vehicle.refresh.mutationOptions());

  // A skipped (null) query reports isLoading forever — only consult it once
  // there's a vehicle and the query actually runs.
  const isLoading =
    vehiclesQuery.isLoading ||
    (vehicle !== undefined && snapshotQuery.isLoading);
  // A failed server logout must be visible too — otherwise tapping "Sign out"
  // with the server down silently does nothing. The refresh (mutation) error
  // is transient — query errors clear themselves on recovery, but a mutation
  // error would sit there until the next refresh.
  const refreshError = useTransientError(refresh.error);
  const errorMessage =
    (vehiclesQuery.error ?? snapshotQuery.error ?? refreshError)?.message ??
    signOutError;

  // First run after login (or after a data wipe) has a vehicle but no stored
  // status yet; kick off one fetch from VW rather than waiting for the cron.
  const noSnapshotYet =
    vehicle !== undefined &&
    !snapshotQuery.isLoading &&
    snapshotQuery.error === undefined &&
    snapshot === undefined;
  const autoRefreshed = useRef(false);
  const { mutate: refreshMutate } = refresh;
  useEffect(() => {
    if (noSnapshotYet && !autoRefreshed.current) {
      autoRefreshed.current = true;
      refreshMutate({});
    }
  }, [noSnapshotYet, refreshMutate]);

  // Native RefreshControl and the header toolbar need a resolved color
  // string, not a Tamagui token.
  const tintColor = theme.color.val;

  // The pull spinner tracks only gesture-initiated refreshes; tying it to
  // refresh.isPending made it pop in when the menu triggered a refresh.
  const [pulling, setPulling] = useState(false);
  const onPullRefresh = () => {
    setPulling(true);
    refresh.mutate(
      {},
      {
        onSettled: () => {
          setPulling(false);
        },
      },
    );
  };

  // The ScrollView must be the screen's first child (no wrapper view) with
  // contentInsetAdjustmentBehavior="automatic", or UIKit won't collapse the
  // large title on scroll and content slides underneath it instead.
  return (
    <>
      {/* The title is the vehicle itself (large title collapses into the bar
          on scroll); pushed screens still label their back button "Home" via
          their own headerBackTitle. */}
      <Stack.Screen options={{ title: vehicle?.nickname ?? "My Vehicle" }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon="ellipsis.circle"
          tintColor={tintColor}
          accessibilityLabel="Menu"
        >
          <Stack.Toolbar.MenuAction
            icon="arrow.clockwise"
            onPress={() => {
              refresh.mutate({});
            }}
          >
            Refresh
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="gearshape"
            onPress={() => {
              router.push("/settings");
            }}
          >
            Settings
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="rectangle.portrait.and.arrow.right"
            destructive
            onPress={signOut}
          >
            Sign out
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <ScrollView
        style={{ flex: 1 }}
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        // paddingTop 2, not 16: the native large title already brings its own
        // bottom margin, and the VIN should read as its subline. paddingBottom
        // clears the floating mic button (VoiceControl) so the last card's
        // controls aren't trapped under it.
        contentContainerStyle={{
          padding: 16,
          paddingTop: 2,
          paddingBottom: 120,
          gap: 16,
        }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={onPullRefresh}
            tintColor={tintColor}
          />
        }
      >
        {vehicle !== undefined ? (
          <Text selectable style={{ color: ios.secondaryLabel, fontSize: 13 }}>
            {vehicle.vin}
          </Text>
        ) : null}

        {isLoading ? (
          <Spinner
            color="$color"
            transition="quick"
            enterStyle={{ opacity: 0 }}
          />
        ) : null}
        <AnimatePresence>
          {errorMessage != null ? (
            <Text
              key="error"
              selectable
              color="$red10"
              transition="quick"
              animateOnly={["opacity"]}
              enterStyle={{ opacity: 0 }}
              exitStyle={{ opacity: 0 }}
            >
              {errorMessage}
            </Text>
          ) : null}
        </AnimatePresence>
        {!vehiclesQuery.isLoading &&
        vehiclesQuery.error === undefined &&
        vehicle === undefined ? (
          <Paragraph
            color="$color10"
            transition="quick"
            enterStyle={{ opacity: 0 }}
          >
            No vehicles found in your VW account.
          </Paragraph>
        ) : null}
        <AnimatePresence>
          {noSnapshotYet ? (
            <IosCard
              key="empty-state"
              p="$4"
              gap="$3"
              items="flex-start"
              transition="quick"
              animateOnly={["opacity", "transform"]}
              enterStyle={{ opacity: 0, y: 20 }}
              exitStyle={{ opacity: 0, y: -10 }}
            >
              <Paragraph color="$color10">
                {refresh.isPending
                  ? "Getting the latest status from your car…"
                  : "No status stored yet."}
              </Paragraph>
              {refresh.isPending ? (
                <Spinner color="$color" />
              ) : (
                <IosButton
                  tone="blue"
                  label="Get status"
                  onPress={() => {
                    refresh.mutate({});
                  }}
                />
              )}
            </IosCard>
          ) : null}
        </AnimatePresence>
        {snapshot !== undefined && vehicle !== undefined ? (
          <StatusCards
            s={snapshot}
            uuid={vehicle.uuid}
            vehicleId={vehicle.id}
          />
        ) : null}
      </ScrollView>
      {/* Floating press-and-hold voice assistant, over the dashboard. */}
      {vehicle !== undefined ? <VoiceControl uuid={vehicle.uuid} /> : null}
    </>
  );
}

function StatusCards({
  s,
  uuid,
  vehicleId,
}: {
  s: Snapshot;
  uuid: string;
  vehicleId: string;
}) {
  // Snapshots only re-render this on arrival; tick so "Xm ago" stays honest.
  const now = useNow();
  const router = useRouter();
  const sec = securitySummary(s);
  const parked =
    s.parkedLat != null && s.parkedLng != null
      ? { lat: s.parkedLat, lng: s.parkedLng }
      : null;
  return (
    <YStack
      gap="$3"
      transition="quick"
      animateOnly={["opacity", "transform"]}
      enterStyle={{ opacity: 0, y: 20 }}
    >
      <ChargeControl s={s} uuid={uuid} />
      <LockControl uuid={uuid} locked={s.locked ?? null} />
      <ClimateControl vehicleId={vehicleId} uuid={uuid} />
      <IosGroup>
        <IosRow label="Odometer" value={formatMiles(s.odometerKm)} />
        <IosRow
          label="Doors & windows"
          value={sec.text}
          warn={sec.warn}
          onPress={() => {
            router.push("/doors");
          }}
        />
        {parked !== null ? (
          <IosRow
            label="Parked"
            value="Location"
            onPress={() => {
              router.push("/parked");
            }}
          />
        ) : null}
        <IosRow
          label="Updated"
          value={agoLabel(s.capturedAt ?? s.createdAt, now)}
          onPress={() => {
            router.push("/updates");
          }}
        />
      </IosGroup>
      <IosGroup>
        <IosRow
          label="Activity"
          value="View"
          onPress={() => {
            router.push("/activity");
          }}
        />
        <IosRow
          label="Messages"
          value="View"
          onPress={() => {
            router.push("/messages");
          }}
        />
      </IosGroup>
    </YStack>
  );
}

/**
 * One-line "is the car sealed?" summary. Surfaces open doors/windows (or, as a
 * fallback, individually unlocked doors) as a warning; otherwise reassures.
 */
function securitySummary(s: Snapshot): { text: string; warn: boolean } {
  const open = openSummary(strArr(s.openDoors), strArr(s.openWindows));
  if (open !== null) return { text: open, warn: true };
  const unlocked = unlockedSummary(strArr(s.unlockedDoors));
  if (unlocked !== null) return { text: unlocked, warn: true };
  return { text: "All closed", warn: false };
}
