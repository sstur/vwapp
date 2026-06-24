/** InstantDB admin access — the only thing that writes to the database. */
import { id, init } from "@instantdb/admin";
import type { StatusDTO, VehicleDTO } from "@vwapp/contract";
import schema from "@vwapp/db";
import type { Sealed } from "./crypto";
import type { AppEnv } from "./env";
import type { InboxMessage, VwTokens } from "./vw/client";

export function getDb(env: AppEnv) {
  return init({
    appId: env.INSTANT_APP_ID,
    adminToken: env.INSTANT_ADMIN_TOKEN,
    schema,
  });
}
export type Db = ReturnType<typeof getDb>;

/**
 * `db.tx.entity[id]` is typed as possibly-undefined under noUncheckedIndexedAccess,
 * but the InstantDB proxy always returns a builder. Narrow without a `!` assertion.
 */
function tx<T>(node: T | undefined): T {
  if (node === undefined) throw new Error("unreachable: InstantDB tx proxy");
  return node;
}

export interface StoredVehicle extends VehicleDTO {
  id: string;
}
export interface StoredAccount {
  id: string;
  sealed: Sealed;
  tokens: VwTokens;
}
export interface StoredUser {
  id: string;
  account: StoredAccount | null;
  vehicles: StoredVehicle[];
}

interface AccountRecord {
  id: string;
  userKey?: string | undefined;
  credCiphertext: string;
  credIv: string;
  accessToken: string;
  refreshToken?: string | undefined;
  idToken?: string | undefined;
  tokenExpiresAt: number;
}
interface VehicleRecord {
  id: string;
  vin: string;
  uuid: string;
  nickname?: string | undefined;
  model?: string | undefined;
}

function toStoredAccount(a: AccountRecord): StoredAccount {
  return {
    id: a.id,
    sealed: { ciphertext: a.credCiphertext, iv: a.credIv },
    tokens: {
      accessToken: a.accessToken,
      refreshToken: a.refreshToken ?? null,
      idToken: a.idToken ?? null,
      expiresAt: a.tokenExpiresAt,
    },
  };
}

function toStoredVehicle(v: VehicleRecord): StoredVehicle {
  return {
    id: v.id,
    vin: v.vin,
    uuid: v.uuid,
    nickname: v.nickname ?? null,
    model: v.model ?? null,
  };
}

/**
 * The user's VW session and garage, by Instant user id. The account (and its
 * vehicles) is shared: any number of clients link to the same vwAccounts row.
 */
export async function getUser(db: Db, userId: string): Promise<StoredUser> {
  const res = await db.query({
    $users: { $: { where: { id: userId } }, account: { vehicles: {} } },
  });
  // verifyToken succeeded, so the $users row exists; an empty result would
  // only mean a wipe raced us. Treat it as a user with nothing stored.
  const account = res.$users[0]?.account ?? null;
  return {
    id: userId,
    account: account === null ? null : toStoredAccount(account),
    vehicles: (account?.vehicles ?? []).map(toStoredVehicle),
  };
}

/** The one VW session for a VW account, by convergence key. */
export async function getAccountByUserKey(
  db: Db,
  userKey: string,
): Promise<StoredAccount | null> {
  const res = await db.query({ vwAccounts: { $: { where: { userKey } } } });
  const account = res.vwAccounts[0];
  return account === undefined ? null : toStoredAccount(account);
}

/** Every stored VW session with its garage — the cron's work list. */
export async function listAccounts(
  db: Db,
): Promise<{ account: StoredAccount; vehicles: StoredVehicle[] }[]> {
  const res = await db.query({ vwAccounts: { vehicles: {} } });
  return res.vwAccounts.map((a) => ({
    account: toStoredAccount(a),
    vehicles: a.vehicles.map(toStoredVehicle),
  }));
}

/** Query the account by userKey and compute the create/update plan for it +
 * its garage. Shared by saveAccountSession (no client attached) and saveLogin
 * (attaches the client). */
async function resolveAccountUpsert(
  db: Db,
  userKey: string,
  sealed: Sealed,
  tokens: VwTokens,
  vehicles: VehicleDTO[],
) {
  const res = await db.query({
    vwAccounts: { $: { where: { userKey } }, vehicles: {} },
  });
  const existing = res.vwAccounts[0];
  const accountId = existing?.id ?? id();
  const existingVehicles = (existing?.vehicles ?? []).map(toStoredVehicle);
  const accountFields = {
    userKey,
    credCiphertext: sealed.ciphertext,
    credIv: sealed.iv,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    tokenExpiresAt: tokens.expiresAt,
  };
  const storedVehicles: StoredVehicle[] = vehicles.map((v) => ({
    ...v,
    id: existingVehicles.find((x) => x.uuid === v.uuid)?.id ?? id(),
  }));
  return {
    exists: existing !== undefined,
    accountId,
    accountFields,
    storedVehicles,
    existingVehicles,
  };
}

function vehicleUpsertOps(
  db: Db,
  accountId: string,
  storedVehicles: StoredVehicle[],
  existingVehicles: StoredVehicle[],
) {
  return storedVehicles.map((v) => {
    const fields = {
      vin: v.vin,
      uuid: v.uuid,
      nickname: v.nickname,
      model: v.model,
    };
    const isNew = !existingVehicles.some((x) => x.id === v.id);
    const vehicleTx = isNew
      ? tx(db.tx.vehicles[v.id]).create(fields)
      : tx(db.tx.vehicles[v.id]).update(fields);
    return vehicleTx.link({ account: accountId });
  });
}

/**
 * Converge on the one VW session for this VW user (keyed by userKey =
 * sha256 of the normalized username): create or update it, refresh creds and
 * tokens, and upsert the garage — but DO NOT attach any client. Used to cache a
 * VW session validated before the S-PIN is known (auth.checkCredentials): the
 * backend is authenticated, but no client is "logged in" until saveLogin links
 * one. Never strips an existing S-PIN (the caller preserves it in `sealed`).
 */
export async function saveAccountSession(
  db: Db,
  userKey: string,
  sealed: Sealed,
  tokens: VwTokens,
  vehicles: VehicleDTO[],
): Promise<StoredVehicle[]> {
  const { exists, accountId, accountFields, storedVehicles, existingVehicles } =
    await resolveAccountUpsert(db, userKey, sealed, tokens, vehicles);
  const node = tx(db.tx.vwAccounts[accountId]);
  await db.transact([
    exists ? node.update(accountFields) : node.create(accountFields),
    ...vehicleUpsertOps(db, accountId, storedVehicles, existingVehicles),
  ]);
  return storedVehicles;
}

/**
 * Like saveAccountSession, but also ATTACHES the logging-in client to the
 * session (this is what makes the client "logged in"). If this client was
 * previously attached to a *different* VW account, detach it from that one.
 */
export async function saveLogin(
  db: Db,
  userId: string,
  userKey: string,
  sealed: Sealed,
  tokens: VwTokens,
  vehicles: VehicleDTO[],
): Promise<StoredVehicle[]> {
  const [prev, resolved] = await Promise.all([
    getUser(db, userId),
    resolveAccountUpsert(db, userKey, sealed, tokens, vehicles),
  ]);
  const { exists, accountId, accountFields, storedVehicles, existingVehicles } =
    resolved;
  const node = tx(db.tx.vwAccounts[accountId]);
  await db.transact([
    ...(prev.account !== null && prev.account.id !== accountId
      ? [tx(db.tx.vwAccounts[prev.account.id]).unlink({ users: userId })]
      : []),
    (exists ? node.update(accountFields) : node.create(accountFields)).link({
      users: userId,
    }),
    ...vehicleUpsertOps(db, accountId, storedVehicles, existingVehicles),
  ]);
  return storedVehicles;
}

export async function updateTokens(
  db: Db,
  accountId: string,
  tokens: VwTokens,
): Promise<void> {
  await db.transact(
    tx(db.tx.vwAccounts[accountId]).update({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      tokenExpiresAt: tokens.expiresAt,
    }),
  );
}

/**
 * Logout: detach this client from the shared VW session — nothing more. The
 * session deliberately persists even with zero attached clients: server-side
 * features (the status cron today, user-defined schedules like timed climate
 * control later) must keep authenticating with VW regardless of who is
 * logged in. Deleting a session is an explicit act (scripts/wipe.ts, or a
 * future account-removal feature). The Instant guest user also stays, so the
 * device keeps its identity for the next login.
 */
export async function clearUserData(db: Db, user: StoredUser): Promise<void> {
  if (user.account === null) return;
  await db.transact(
    tx(db.tx.vwAccounts[user.account.id]).unlink({ users: user.id }),
  );
}

/**
 * Store a status snapshot. By default skips writing when nothing the car
 * reports has advanced since the latest stored row (the cron would otherwise
 * pile up identical rows while the car sleeps). "Nothing advanced" means the
 * charge capture time AND every RVS/closure update timestamp match — crucially
 * NOT capturedAt alone: capturedAt comes from the charge/EV endpoint, but
 * door/lock/window state comes from RVS with its own timestamps, so a door
 * opening or unlocking while the charge capture is frozen must still be
 * recorded (it otherwise deduped away — losing a safety-relevant transition).
 * Pass `force` to always write — used for the optimistic post-command snapshot,
 * whose `locked` reflects the command we just issued rather than VW's (laggy)
 * read-back.
 */
export async function saveSnapshot(
  db: Db,
  vehicleId: string,
  status: StatusDTO,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const latest = await getLatestSnapshot(db, vehicleId);
  if (
    opts.force !== true &&
    latest !== undefined &&
    status.capturedAt !== null &&
    latest.capturedAt === status.capturedAt &&
    latest.rvsUpdatedAt === status.rvsUpdatedAt &&
    latest.doorsUpdatedAt === status.doorsUpdatedAt &&
    latest.locksUpdatedAt === status.locksUpdatedAt &&
    latest.windowsUpdatedAt === status.windowsUpdatedAt
  ) {
    return false; // deduped — VW reported nothing new
  }
  await db.transact(
    tx(db.tx.snapshots[id()])
      .create({
        createdAt: Date.now(),
        capturedAt: status.capturedAt,
        soc: status.soc,
        chargeState: status.chargeState,
        chargePowerKw: status.chargePowerKw,
        minutesToFull: status.minutesToFull,
        pluggedIn: status.pluggedIn,
        plugLocked: status.plugLocked,
        targetSoc: status.targetSoc,
        locked: status.locked,
        openDoors: status.openDoors,
        openWindows: status.openWindows,
        unlockedDoors: status.unlockedDoors,
        rangeKm: status.rangeKm,
        odometerKm: status.odometerKm,
        parkedLat: status.parkedLat,
        parkedLng: status.parkedLng,
        parkedAt: status.parkedAt,
        rvsUpdatedAt: status.rvsUpdatedAt,
        doorsUpdatedAt: status.doorsUpdatedAt,
        locksUpdatedAt: status.locksUpdatedAt,
        windowsUpdatedAt: status.windowsUpdatedAt,
        chargeUpdatedAt: status.chargeUpdatedAt,
      })
      .link({ vehicle: vehicleId }),
  );
  return true;
}

export async function getLatestSnapshot(db: Db, vehicleId: string) {
  const res = await db.query({
    snapshots: {
      $: {
        where: { "vehicle.id": vehicleId },
        order: { createdAt: "desc" },
        limit: 1,
      },
    },
  });
  return res.snapshots[0];
}

/** parkedAt of the vehicle's latest snapshot — when the car last parked. */
export async function latestParkedAt(
  db: Db,
  vehicleId: string,
): Promise<number | null> {
  return (await getLatestSnapshot(db, vehicleId))?.parkedAt ?? null;
}

/** Delete snapshots older than the cutoff (batched; the cron calls this). */
export async function pruneSnapshots(
  db: Db,
  cutoffEpochMs: number,
): Promise<number> {
  const res = await db.query({
    snapshots: {
      $: { where: { createdAt: { $lt: cutoffEpochMs } }, limit: 200 },
    },
  });
  if (res.snapshots.length > 0) {
    await db.transact(
      res.snapshots.map((s) => tx(db.tx.snapshots[s.id]).delete()),
    );
  }
  return res.snapshots.length;
}

// ---- climate sessions ------------------------------------------------------

export interface ClimateSession {
  id: string;
  tempF: number;
  expiresAt: number;
  startedAt: number;
  state: string;
  lastStartAt: number | null;
  remainingMin: number | null;
  pausedAt: number | null;
}
interface ClimateSessionRecord {
  id: string;
  tempF: number;
  expiresAt: number;
  startedAt: number;
  state: string;
  lastStartAt?: number | undefined;
  remainingMin?: number | undefined;
  pausedAt?: number | undefined;
}
function toClimateSession(s: ClimateSessionRecord): ClimateSession {
  return {
    id: s.id,
    tempF: s.tempF,
    expiresAt: s.expiresAt,
    startedAt: s.startedAt,
    state: s.state,
    lastStartAt: s.lastStartAt ?? null,
    remainingMin: s.remainingMin ?? null,
    pausedAt: s.pausedAt ?? null,
  };
}

/** The active managed climate session for a vehicle, if any. */
export async function getActiveClimateSession(
  db: Db,
  vehicleId: string,
): Promise<ClimateSession | null> {
  const res = await db.query({
    climateSessions: {
      $: { where: { "vehicle.id": vehicleId, state: "active" } },
    },
  });
  const s = res.climateSessions[0];
  return s === undefined ? null : toClimateSession(s);
}

/** All active climate sessions with their vehicle + owning account — cron work list. */
export async function listActiveClimateSessions(
  db: Db,
): Promise<
  { session: ClimateSession; vehicle: StoredVehicle; account: StoredAccount }[]
> {
  const res = await db.query({
    climateSessions: {
      $: { where: { state: "active" } },
      vehicle: { account: {} },
    },
  });
  const out: {
    session: ClimateSession;
    vehicle: StoredVehicle;
    account: StoredAccount;
  }[] = [];
  for (const s of res.climateSessions) {
    const vehicle = s.vehicle;
    const account = vehicle?.account;
    if (vehicle === undefined || account === undefined) continue; // orphaned — skip
    out.push({
      session: toClimateSession(s),
      vehicle: toStoredVehicle(vehicle),
      account: toStoredAccount(account),
    });
  }
  return out;
}

/**
 * Create or replace the active climate session for a vehicle (one active per
 * vehicle — any prior active row is ended first).
 */
export async function startClimateSession(
  db: Db,
  vehicleId: string,
  fields: { tempF: number; expiresAt: number },
): Promise<void> {
  const prior = await getActiveClimateSession(db, vehicleId);
  const now = Date.now();
  await db.transact([
    ...(prior !== null
      ? [tx(db.tx.climateSessions[prior.id]).update({ state: "stopped" })]
      : []),
    tx(db.tx.climateSessions[id()])
      .create({
        tempF: fields.tempF,
        expiresAt: fields.expiresAt,
        startedAt: now,
        state: "active",
        lastStartAt: now,
      })
      .link({ vehicle: vehicleId }),
  ]);
}

export async function updateClimateSession(
  db: Db,
  sessionId: string,
  fields: Partial<{
    state: string;
    expiresAt: number;
    lastStartAt: number;
    remainingMin: number;
    error: string;
    pausedAt: number | null;
  }>,
): Promise<void> {
  await db.transact(tx(db.tx.climateSessions[sessionId]).update(fields));
}

/** End the active climate session for a vehicle (e.g. on explicit stop). */
export async function endClimateSession(
  db: Db,
  vehicleId: string,
  state: string,
): Promise<void> {
  const active = await getActiveClimateSession(db, vehicleId);
  if (active !== null) await updateClimateSession(db, active.id, { state });
}

// ---- message center mirror -------------------------------------------------

export interface StoredMessage {
  id: string;
  messageId: string;
  title: string;
  body: string | null;
  at: number | null;
  read: boolean;
  readOverride: boolean | null;
  deletedAt: number | null;
  createdAt: number;
}
interface MessageRecord {
  id: string;
  messageId: string;
  title: string;
  body?: string | undefined;
  at?: number | undefined;
  read: boolean;
  readOverride?: boolean | null | undefined;
  deletedAt?: number | null | undefined;
  createdAt: number;
}

/**
 * Mirror VW's inbox into our DB: upsert each fetched message (refreshing VW's
 * fields, including `read`) and prune rows VW no longer returns — i.e. genuine
 * upstream deletions. Our per-message overrides (`readOverride`, `deletedAt`)
 * are PRESERVED: the upsert writes only VW's own fields, and Instant's `update`
 * merges, so our columns are left untouched — a message the user soft-deleted
 * stays hidden even though VW keeps returning it. `complete` is true when the
 * fetch returned the whole inbox (fewer rows than the page size); otherwise we
 * only prune within the fetched window (messages at/after the oldest fetched
 * one), so older paginated-out messages aren't mistaken for deletions.
 */
export async function syncMessages(
  db: Db,
  accountId: string,
  vw: InboxMessage[],
  complete: boolean,
): Promise<void> {
  const res = await db.query({
    vwAccounts: { $: { where: { id: accountId } }, messages: {} },
  });
  const existing = (res.vwAccounts[0]?.messages ?? []) as MessageRecord[];
  const byMessageId = new Map(existing.map((m) => [m.messageId, m]));
  const now = Date.now();

  const ops = vw.map((m) => {
    const prev = byMessageId.get(m.id);
    const rowId = prev?.id ?? id();
    const fields = {
      messageId: m.id,
      title: m.title,
      body: m.body,
      at: m.at,
      read: m.read,
      createdAt: prev?.createdAt ?? m.at ?? now,
    };
    const node = tx(db.tx.messages[rowId]);
    return (
      prev === undefined ? node.create(fields) : node.update(fields)
    ).link({ account: accountId });
  });

  const fetchedIds = new Set(vw.map((m) => m.id));
  const fetchedAts = vw.map((m) => m.at).filter((a): a is number => a !== null);
  const oldestFetchedAt =
    fetchedAts.length > 0 ? Math.min(...fetchedAts) : null;
  const deletions = existing
    .filter((row) => {
      if (fetchedIds.has(row.messageId)) return false;
      return (
        complete ||
        (oldestFetchedAt !== null && (row.at ?? 0) >= oldestFetchedAt)
      );
    })
    .map((row) => tx(db.tx.messages[row.id]).delete());

  const all = [...ops, ...deletions];
  if (all.length > 0) await db.transact(all);
}

/**
 * Set (or clear) our per-message read override. `override` true = read,
 * false = unread, null = follow VW's own flag. No-op if the message is gone.
 */
export async function setMessageReadOverride(
  db: Db,
  accountId: string,
  messageId: string,
  override: boolean | null,
): Promise<boolean> {
  const res = await db.query({
    vwAccounts: {
      $: { where: { id: accountId } },
      messages: { $: { where: { messageId } } },
    },
  });
  const row = res.vwAccounts[0]?.messages[0];
  if (row === undefined) return false;
  await db.transact(
    tx(db.tx.messages[row.id]).update({ readOverride: override }),
  );
  return true;
}

/**
 * Soft-delete (or restore) a message in OUR DB only — never sent to VW. `deleted`
 * true stamps `deletedAt` so the app hides the row; false clears it. The row is
 * kept (not removed) so it survives VW re-syncs that still return the message;
 * it's only truly removed if VW itself stops returning it (see syncMessages).
 * No-op if the message is gone.
 */
export async function setMessageDeleted(
  db: Db,
  accountId: string,
  messageId: string,
  deleted: boolean,
): Promise<boolean> {
  const res = await db.query({
    vwAccounts: {
      $: { where: { id: accountId } },
      messages: { $: { where: { messageId } } },
    },
  });
  const row = res.vwAccounts[0]?.messages[0];
  if (row === undefined) return false;
  await db.transact(
    tx(db.tx.messages[row.id]).update({
      deletedAt: deleted ? Date.now() : null,
    }),
  );
  return true;
}
