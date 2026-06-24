import { SfIcon } from "@/components/sf-icon";
import { db } from "@/db";
import { previewText } from "@/html";
import { useIosColors } from "@/ios-colors";
import { orpc } from "@/rpc";
import type { InstaQLEntity } from "@instantdb/react-native";
import { useMutation } from "@tanstack/react-query";
import type { AppSchema } from "@vwapp/db";
import { Stack, useRouter } from "expo-router";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Platform,
  Pressable,
  RefreshControl,
  Text as RNText,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { Paragraph, Spinner, Text, useTheme } from "tamagui";

// iMessage is a *plain* full-bleed list (not the insetGrouped card the rest of
// the app uses): rows run edge-to-edge on the system background with a hairline
// separator between them, inset to start at the title (past the avatar).
const AVATAR = 52; // avatar diameter
const DOT_GUTTER = 28; // reserved leading column for the unread dot
const TEXT_GAP = 12; // avatar → text column
// Separator (and text) leading edge = past the avatar.
const ROW_INSET = DOT_GUTTER + AVATAR + TEXT_GAP;

type Message = InstaQLEntity<AppSchema, "messages">;

/** Effective read state: our override wins over VW's mirrored flag. */
function isRead(m: Message): boolean {
  return m.readOverride ?? m.read;
}

/**
 * myVW message-center inbox. The app reads messages from InstantDB (the Worker
 * mirrors them from VW); pulling to refresh asks the Worker to re-sync. The app
 * never talks to VW directly.
 */
export default function MessagesScreen() {
  // Native RefreshControl needs a resolved color string, not a Tamagui token.
  const theme = useTheme();
  const c = useIosColors();
  const q = db.useQuery({
    messages: { $: { order: { createdAt: "desc" } } },
  });
  // Soft-deleted messages stay in the DB (so they survive VW re-syncs) but are
  // hidden here — filtered client-side rather than in the query so an absent
  // attribute can't accidentally exclude a row.
  const messages = (q.data?.messages ?? []).filter((m) => m.deletedAt == null);

  // Re-sync from VW on open + pull-to-refresh; new/updated/deleted messages then
  // arrive through the live query above.
  const refresh = useMutation(orpc.vehicle.refreshMessages.mutationOptions());
  const { mutate: refreshMutate } = refresh;
  useEffect(() => {
    refreshMutate({});
  }, [refreshMutate]);

  // The pull spinner must track ONLY gesture-initiated refreshes. Binding it to
  // refresh.isPending makes the RefreshControl programmatically "refreshing" on
  // mount (we auto-sync above), and iOS then holds the content offset down by
  // the spinner's height (~60pt) until the VW round-trip finishes — reading as
  // a big gap under the large title. (Same fix as the dashboard.)
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

  return (
    <>
      <Stack.Screen
        options={{
          title: "Messages",
          headerBackTitle: "Home",
          // Plain list sits on systemBackground (white/black), not the grey
          // grouped background the cards-based screens use.
          contentStyle: { backgroundColor: c.systemBackground },
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: c.systemBackground }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={onPullRefresh}
            tintColor={theme.color.val}
          />
        }
      >
        {q.isLoading ? (
          <View style={{ padding: 16 }}>
            <Spinner color="$color" />
          </View>
        ) : null}
        {refresh.error ? (
          <View style={{ padding: 16 }}>
            <Text selectable color="$red10">
              {refresh.error.message}
            </Text>
          </View>
        ) : null}
        {!q.isLoading && messages.length === 0 ? (
          <View style={{ padding: 16 }}>
            <Paragraph color="$color10">No messages.</Paragraph>
          </View>
        ) : null}
        {messages.map((m, i) => (
          <Fragment key={m.id}>
            <MailRow m={m} />
            {i < messages.length - 1 ? (
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: c.separator,
                  marginLeft: ROW_INSET,
                }}
              />
            ) : null}
          </Fragment>
        ))}
      </ScrollView>
    </>
  );
}

/** Width of each swipe-action button (iOS Mail uses ≈ 74–80pt). */
const ACTION_W = 80;

/**
 * iMessage/Mail-style conversation row. A far-left unread dot, a circular "VW"
 * avatar (we have no sender photos — every message is from VW), the bold title,
 * a relative date + chevron, and a two-line preview. Interactions:
 *   • tap → open the detail screen (which marks it read)
 *   • swipe right (leading) → Mark as Read / Unread (blue)
 *   • swipe left (trailing) → Delete (red — soft-delete in our DB only)
 *   • long-press → the same actions in a sheet (a non-gesture path)
 */
function MailRow({ m }: { m: Message }) {
  const c = useIosColors();
  const router = useRouter();
  const setRead = useMutation(orpc.vehicle.setMessageRead.mutationOptions());
  const setDeleted = useMutation(
    orpc.vehicle.setMessageDeleted.mutationOptions(),
  );
  const swipeRef = useRef<SwipeableMethods>(null);
  const unread = !isRead(m);
  const preview =
    m.body != null && m.body !== "" ? previewText(m.body) : undefined;

  const toggleRead = () => {
    setRead.mutate({ messageId: m.messageId, read: unread });
    swipeRef.current?.close();
  };
  const remove = () => {
    swipeRef.current?.close();
    // The row vanishes via the live query (deletedAt set) — no local state.
    setDeleted.mutate({ messageId: m.messageId, deleted: true });
  };

  // Long-press mirrors the swipe actions for discoverability, and is the only
  // delete path on Android (no ActionSheetIOS there).
  const showActions = () => {
    if (Platform.OS !== "ios") {
      toggleRead();
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [
          unread ? "Mark as Read" : "Mark as Unread",
          "Delete",
          "Cancel",
        ],
        destructiveButtonIndex: 1,
        cancelButtonIndex: 2,
      },
      (idx) => {
        if (idx === 0) toggleRead();
        else if (idx === 1) remove();
      },
    );
  };

  return (
    <ReanimatedSwipeable
      ref={swipeRef}
      friction={2}
      overshootFriction={8}
      leftThreshold={ACTION_W * 0.5}
      rightThreshold={ACTION_W * 0.5}
      renderLeftActions={() => (
        <Pressable
          accessibilityRole="button"
          onPress={toggleRead}
          style={{
            width: ACTION_W,
            backgroundColor: c.blue,
            alignItems: "center",
            justifyContent: "center",
            gap: 3,
          }}
        >
          <SfIcon
            name={unread ? "envelope.open.fill" : "envelope.badge.fill"}
            size={24}
            color="#FFFFFF"
          />
          <RNText style={{ color: "#FFFFFF", fontSize: 13 }}>
            {unread ? "Read" : "Unread"}
          </RNText>
        </Pressable>
      )}
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          onPress={remove}
          style={{
            width: ACTION_W,
            backgroundColor: c.red,
            alignItems: "center",
            justifyContent: "center",
            gap: 3,
          }}
        >
          <SfIcon name="trash.fill" size={24} color="#FFFFFF" />
          <RNText style={{ color: "#FFFFFF", fontSize: 13 }}>Delete</RNText>
        </Pressable>
      )}
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          router.push({ pathname: "/message", params: { id: m.messageId } });
        }}
        onLongPress={showActions}
        // Opaque base (not transparent) so the row occludes the coloured action
        // panels until it's actually slid aside.
        style={({ pressed }) => ({
          backgroundColor: pressed ? c.selection : c.systemBackground,
        })}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingRight: 16,
            paddingVertical: 10,
          }}
        >
          {/* Reserved unread-dot gutter. It's ALWAYS present (empty when read) so
            avatars and text stay at a fixed x whether or not anything is unread
            — exactly how iMessage keeps the list aligned. */}
          <View
            style={{
              width: DOT_GUTTER,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {unread ? (
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: c.blue,
                }}
              />
            ) : null}
          </View>
          {/* Avatar: "VW" initials, since there are no per-sender photos. */}
          <View
            style={{
              width: AVATAR,
              height: AVATAR,
              borderRadius: AVATAR / 2,
              backgroundColor: "#8E8E93",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <RNText
              style={{ fontSize: 18, fontWeight: "600", color: "#FFFFFF" }}
            >
              VW
            </RNText>
          </View>
          <View style={{ flex: 1, marginLeft: TEXT_GAP, gap: 2 }}>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <RNText
                numberOfLines={1}
                style={{
                  flex: 1,
                  fontSize: 17,
                  fontWeight: "600",
                  color: c.label,
                }}
              >
                {m.title}
              </RNText>
              {m.at != null ? (
                <RNText style={{ fontSize: 15, color: c.secondaryLabel }}>
                  {messageDate(m.at)}
                </RNText>
              ) : null}
              <SfIcon name="chevron.right" size={13} color={c.chevron} />
            </View>
            {preview !== undefined ? (
              <RNText
                numberOfLines={2}
                style={{
                  fontSize: 15,
                  lineHeight: 20,
                  color: c.secondaryLabel,
                }}
              >
                {preview}
              </RNText>
            ) : null}
          </View>
        </View>
      </Pressable>
    </ReanimatedSwipeable>
  );
}

/** iMessage-style: time today, "Yesterday", weekday this week, else a date. */
function messageDate(epochMs: number): string {
  const d = new Date(epochMs);
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const daysAgo = Math.floor(
    (startOfToday - new Date(d).setHours(0, 0, 0, 0)) / dayMs,
  );
  if (daysAgo <= 0)
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}
