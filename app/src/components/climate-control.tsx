import { SfIcon } from "@/components/sf-icon";
import { db } from "@/db";
import { useNow } from "@/hooks/use-now";
import { useTransientError } from "@/hooks/use-transient-error";
import { orpc } from "@/rpc";
import {
  useIsMutating,
  useMutation,
  useMutationState,
} from "@tanstack/react-query";
import { useRouter } from "expo-router";
import {
  AnimatePresence,
  Paragraph,
  Spinner,
  Text,
  View,
  XStack,
  YStack,
} from "tamagui";
import { IosButton, IosCard } from "./ios-list";

/**
 * Stable key for the climate-start mutation. The Start/Adjust UI lives in the
 * `/climate` route (a native form sheet), but its in-flight state must show on
 * THIS card even after that sheet is dismissed mid-submit — so the route fires
 * the mutation under this key and the card observes it via the mutation cache,
 * rather than owning the mutation itself.
 */
export function climateStartKey(uuid: string): string[] {
  return ["climate", "start", uuid];
}

/**
 * Climate control card. A managed session (live-queried from `climateSessions`)
 * is what the cron keeps warm; while one is active we show its target temp and
 * end time with a Stop. The Start/Adjust buttons open the `/climate` form sheet
 * (a native iOS sheet, so its drag-to-dismiss coordinates with the native time
 * wheel inside). The start RPC confirms with VW and may take a few seconds; its
 * pending/error state is mirrored here (see `climateStartKey`) so dismissing the
 * sheet mid-submit doesn't hide that a command is still running.
 */
export function ClimateControl({
  vehicleId,
  uuid,
}: {
  vehicleId: string;
  uuid: string;
}) {
  const router = useRouter();
  // Ticks so the end-time label flips to "turning off soon" on time — the
  // cron + 1-min polling can otherwise leave "until 2:55" on screen at 2:56.
  const now = useNow(15_000);
  const sessionQuery = db.useQuery({
    climateSessions: {
      $: { where: { "vehicle.id": vehicleId, state: "active" } },
    },
  });
  const session = sessionQuery.data?.climateSessions[0];
  const active = session !== undefined;

  // Observe the start mutation fired by the /climate route, so this card shows
  // "Starting…"/errors even once that sheet has closed.
  const startPending =
    useIsMutating({ mutationKey: climateStartKey(uuid) }) > 0;
  const startErrors = useMutationState({
    filters: { mutationKey: climateStartKey(uuid), status: "error" },
    select: (m) => ({ error: m.state.error, at: m.state.submittedAt }),
  });
  // Only a fresh failure: the errored mutation lingers in the cache (gc ~5min),
  // so without this gate it would re-flash if the dashboard remounts.
  const lastStartError = startErrors[startErrors.length - 1];
  const startError =
    lastStartError !== undefined && isFresh(lastStartError.at)
      ? lastStartError.error
      : null;

  const stopCmd = useMutation(orpc.vehicle.climateStop.mutationOptions());
  const error = useTransientError(startError ?? stopCmd.error ?? null);

  const openStart = () => {
    router.push({
      pathname: "/climate",
      params: { uuid, vehicleId, mode: "start" },
    });
  };
  const openAdjust = () => {
    if (session === undefined) return;
    router.push({
      pathname: "/climate",
      params: {
        uuid,
        vehicleId,
        mode: "adjust",
        tempF: String(session.tempF),
        endMs: String(session.expiresAt),
      },
    });
  };

  return (
    <IosCard p="$4" gap="$3">
      {/* Single row: state on the left, actions inline on the right. A busy
          spinner REPLACES the leading icon (same 26pt slot) — inserted
          mid-row it squeezes the flex label into wrapping. The start state
          lives HERE, not just in the sheet: dismissing the sheet mid-submit
          doesn't abort the command, and the card is what proves that. */}
      <XStack items="center" gap="$3">
        {stopCmd.isPending || startPending ? (
          <View width={26} items="center">
            <Spinner color="$color10" />
          </View>
        ) : active ? (
          <SfIcon name="wind" color="$blue10" size={26} />
        ) : (
          <SfIcon name="thermometer.medium" color="$color10" size={26} />
        )}
        <YStack flex={1}>
          <Paragraph color="$color" fontWeight="700" fontSize="$6">
            {startPending
              ? active
                ? "Updating climate…"
                : "Starting climate…"
              : active
                ? "Climate on"
                : "Climate off"}
          </Paragraph>
          {session !== undefined ? (
            <Paragraph color="$color10" fontSize="$2">
              {session.expiresAt - now <= 60_000
                ? // Within a minute of (or past) the end: the exact time reads
                  // as stale/wrong, and the cron is about to shut it off.
                  `${String(session.tempF)}°F · turning off soon`
                : session.pausedAt != null
                  ? // VW rejected the start (car in use); the cron resumes the
                    // session once the car parks.
                    `${String(session.tempF)}°F · resumes after parking`
                  : `${String(session.tempF)}°F · until ${formatClock(session.expiresAt)}` +
                    (session.remainingMin != null &&
                    session.remainingMin > 0 &&
                    !isLastCycle(session.expiresAt, session.remainingMin)
                      ? ` · cycle ${String(session.remainingMin)}m`
                      : "")}
            </Paragraph>
          ) : null}
        </YStack>
        {active ? (
          <>
            <IosButton
              tone="blue"
              variant="tinted"
              label="Adjust"
              onPress={openAdjust}
              disabled={stopCmd.isPending || startPending}
            />
            <IosButton
              tone="red"
              disabled={stopCmd.isPending || startPending}
              onPress={() => {
                stopCmd.mutate({ uuid });
              }}
              label="Stop"
            />
          </>
        ) : (
          <IosButton
            tone="blue"
            icon="wind"
            disabled={startPending}
            onPress={openStart}
            label="Start"
          />
        )}
      </XStack>

      <AnimatePresence>
        {error ? (
          <Text
            key="climate-error"
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

/** Whether a mutation submitted at `at` is recent enough to still surface its
 * error (vs. a stale one left in React Query's cache). */
function isFresh(at: number): boolean {
  return Date.now() - at < 12_000;
}

function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * True once the current climatization cycle outlasts the session end: the
 * cron will stop it at `expiresAt` rather than start another, so showing the
 * cycle countdown next to a sooner "until" time would mislead.
 */
function isLastCycle(expiresAt: number, remainingMin: number): boolean {
  return expiresAt - Date.now() <= remainingMin * 60000;
}
