/**
 * "Vehicle data update" events (lock, doors, windows, plug, charging),
 * derived by diffing consecutive stored snapshots — the change-detection
 * id-buzz-monitor does server-side. VW's own activity feed only logs remote
 * command requests, so without these the Activity screen misses everything
 * the car does on its own (driver locks it, a door opens, charging starts).
 */
import { doorLabel, strArr, windowLabel } from "@/closures";
import type { InstaQLEntity } from "@instantdb/react-native";
import type { AppSchema } from "@vwapp/db";
import type { SymbolViewProps } from "expo-symbols";

type Snapshot = InstaQLEntity<AppSchema, "snapshots">;

export interface UpdateEvent {
  at: number;
  title: string;
  description: string | null;
  icon: SymbolViewProps["name"];
}

/**
 * Diffs each snapshot against its predecessor (any input order; sorted by
 * `createdAt` internally) and returns the transitions, oldest first.
 */
export function snapshotUpdates(snapshots: Snapshot[]): UpdateEvent[] {
  const ordered = [...snapshots].sort((a, b) => a.createdAt - b.createdAt);
  const events: UpdateEvent[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const next = ordered[i];
    if (prev !== undefined && next !== undefined) diffPair(prev, next, events);
  }
  return events;
}

function diffPair(prev: Snapshot, next: Snapshot, out: UpdateEvent[]): void {
  // capturedAt is the car's own report time; createdAt (our poll time) only
  // backstops old rows that predate it.
  const at = next.capturedAt ?? next.createdAt;
  const battery =
    next.soc != null ? `Battery ${String(Math.round(next.soc))}%` : null;

  // Every comparison below requires the field on BOTH sides: a value
  // (re)appearing after a gap in VW's reporting is not a real-world event.

  if (
    prev.locked != null &&
    next.locked != null &&
    prev.locked !== next.locked
  ) {
    out.push(
      next.locked
        ? { at, title: "Locked", description: null, icon: "lock.fill" }
        : { at, title: "Unlocked", description: null, icon: "lock.open.fill" },
    );
  }

  if (prev.openDoors !== undefined && next.openDoors !== undefined) {
    for (const d of added(prev.openDoors, next.openDoors)) {
      out.push({
        at,
        title: `${doorLabel(d)} opened`,
        description: null,
        icon: "door.left.hand.open",
      });
    }
    for (const d of added(next.openDoors, prev.openDoors)) {
      out.push({
        at,
        title: `${doorLabel(d)} closed`,
        description: null,
        icon: "door.left.hand.closed",
      });
    }
  }

  if (prev.openWindows !== undefined && next.openWindows !== undefined) {
    for (const w of added(prev.openWindows, next.openWindows)) {
      out.push({
        at,
        title: `${windowName(w)} opened`,
        description: null,
        icon: "wind",
      });
    }
    for (const w of added(next.openWindows, prev.openWindows)) {
      out.push({
        at,
        title: `${windowName(w)} closed`,
        description: null,
        icon: "wind",
      });
    }
  }

  if (
    prev.pluggedIn != null &&
    next.pluggedIn != null &&
    prev.pluggedIn !== next.pluggedIn
  ) {
    out.push(
      next.pluggedIn
        ? {
            at,
            title: "Plugged in",
            description: battery,
            icon: "powerplug.fill",
          }
        : { at, title: "Unplugged", description: battery, icon: "powerplug" },
    );
  }

  if (prev.chargeState != null && next.chargeState != null) {
    const was = isChargingState(prev.chargeState);
    const now = isChargingState(next.chargeState);
    if (!was && now) {
      const power =
        next.chargePowerKw != null && next.chargePowerKw > 0
          ? `${String(next.chargePowerKw)} kW`
          : null;
      const parts = [battery, power].filter(
        (part): part is string => part !== null,
      );
      out.push({
        at,
        title: "Charging started",
        description: parts.length > 0 ? parts.join(" · ") : null,
        icon: "bolt.fill",
      });
    } else if (was && !now) {
      out.push({
        at,
        title: "Charging stopped",
        description: battery,
        icon: "bolt.slash.fill",
      });
    }
  }
}

/** Names in `b` that aren't in `a` (json fields arrive loosely typed). */
function added(a: unknown, b: unknown): string[] {
  const before = new Set(strArr(a));
  return strArr(b).filter((name) => !before.has(name));
}

function windowName(w: string): string {
  return w === "sun roof" ? "Sunroof" : `${windowLabel(w)} window`;
}

/** Same reading of VW's state as the dashboard charge card's `isCharging`.
 *  Active charging only: VW's idle, target-reached states can END in "Charging"
 *  (e.g. "chargePurposeReachedAndNotConservationCharging"), so a substring match
 *  wrongly flags them — the actively-charging states START with "charging". */
function isChargingState(state: string): boolean {
  return state.toLowerCase().startsWith("charging");
}
