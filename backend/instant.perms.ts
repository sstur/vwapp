import type { InstantRules } from "@instantdb/admin";

// The Worker's admin SDK bypasses these rules entirely. They exist for the
// Expo client, which signs in as an Instant guest and live-queries only its
// own vehicles and snapshots. vwAccounts (sealed VW credentials + tokens)
// stays under the deny-all default.
const rules = {
  $default: {
    allow: {
      $default: "false",
    },
  },
  // Guest sign-in creates a $users row, so `create` must stay open despite the
  // deny-all default. `delete` cannot be overridden and defaults to false.
  $users: {
    allow: {
      view: "auth.id == data.id",
      create: "true",
      update: "false",
    },
  },
  vehicles: {
    allow: {
      view: "auth.id in data.ref('account.users.id')",
    },
  },
  snapshots: {
    allow: {
      view: "auth.id in data.ref('vehicle.account.users.id')",
    },
  },
  climateSessions: {
    allow: {
      view: "auth.id in data.ref('vehicle.account.users.id')",
    },
  },
  messages: {
    allow: {
      view: "auth.id in data.ref('account.users.id')",
    },
  },
} satisfies InstantRules;

export default rules;
