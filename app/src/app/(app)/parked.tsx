import { SfIcon } from "@/components/sf-icon";
import { db } from "@/db";
import { agoLabel, useNow } from "@/hooks/use-now";
import { useThemeToggle } from "@/providers/theme-provider";
import { orpc } from "@/rpc";
import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import type { ReactNode } from "react";
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  useWindowDimensions,
} from "react-native";
import { Button, Paragraph, Spinner, Text, XStack, YStack } from "tamagui";

const MAP_HEIGHT = 200;

/**
 * Where the car last parked: the location details we have from VW (a mini-map
 * embed is a likely future addition), with handoff buttons to Apple Maps and
 * Google Maps.
 */
export default function ParkedScreen() {
  const now = useNow();
  // Same live-query pair as the dashboard.
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
  const errorMessage = (vehiclesQuery.error ?? snapshotQuery.error)?.message;

  const parked =
    snapshot?.parkedLat != null && snapshot.parkedLng != null
      ? {
          lat: snapshot.parkedLat,
          lng: snapshot.parkedLng,
          at: snapshot.parkedAt ?? null,
        }
      : null;

  return (
    <>
      <Stack.Screen
        options={{ title: "Parked location", headerBackTitle: "Home" }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
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
        {!isLoading && errorMessage == null && parked === null ? (
          <Paragraph color="$color10">
            No parked location stored. The car reports where it parked when it’s
            switched off; it should appear after the next check-in.
          </Paragraph>
        ) : null}

        {parked !== null ? (
          <YStack
            gap="$4"
            transition="quick"
            animateOnly={["opacity", "transform"]}
            enterStyle={{ opacity: 0, y: 20 }}
          >
            <MapPanel lat={parked.lat} lng={parked.lng} />

            <YStack
              bg="$color2"
              borderWidth={1}
              borderColor="$borderColor"
              rounded="$6"
              p="$4"
              gap="$3"
            >
              <XStack items="center" gap="$3">
                <SfIcon name="mappin.and.ellipse" color="$blue10" size={26} />
                <YStack flex={1}>
                  <Paragraph color="$color" fontWeight="700" fontSize="$6">
                    Last parked
                  </Paragraph>
                  {parked.at !== null ? (
                    <Paragraph color="$color10" fontSize="$2">
                      {`${clockLabel(parked.at, now)} · ${agoLabel(parked.at, now)}`}
                    </Paragraph>
                  ) : null}
                </YStack>
              </XStack>
              <XStack justify="space-between" items="center" gap="$3">
                <Paragraph color="$color10">Coordinates</Paragraph>
                <Paragraph
                  selectable
                  color="$color"
                  fontWeight="600"
                  fontVariant={["tabular-nums"]}
                >
                  {`${parked.lat.toFixed(5)}, ${parked.lng.toFixed(5)}`}
                </Paragraph>
              </XStack>
            </YStack>

            <YStack gap="$3">
              <Button
                size="$5"
                theme="blue"
                icon={<SfIcon name="map.fill" />}
                onPress={() => {
                  void Linking.openURL(appleMapsUrl(parked.lat, parked.lng));
                }}
              >
                Open in Apple Maps
              </Button>
              <Button
                size="$5"
                icon={<SfIcon name="map" />}
                onPress={() => {
                  void openGoogleMaps(parked.lat, parked.lng);
                }}
              >
                Open in Google Maps
              </Button>
            </YStack>
          </YStack>
        ) : null}
      </ScrollView>
    </>
  );
}

/** Centered fill used for the map's loading and error states. */
function MapBox({ children }: { children?: ReactNode }) {
  return (
    <YStack flex={1} bg="$color2" items="center" justify="center" gap="$2">
      {children}
    </YStack>
  );
}

/**
 * Inline map: a static Apple Maps snapshot the Worker signs server-side (no
 * native map module, so it renders identically in Expo Go and production).
 * Tapping it opens the full Apple Maps app. The signed URL carries a
 * time-boxed MapKit token, so we cache it for under the token's lifetime and
 * let it refetch (re-sign) after — the query key (coords + theme) also busts
 * it whenever the location or appearance changes.
 */
function MapPanel({ lat, lng }: { lat: number; lng: number }) {
  const { pref } = useThemeToggle();
  const { width } = useWindowDimensions();
  const widthPt = Math.min(640, Math.max(100, Math.round(width - 32)));
  const map = useQuery({
    ...orpc.vehicle.parkedMapUrl.queryOptions({
      input: { lat, lng, widthPt, heightPt: MAP_HEIGHT, dark: pref === "dark" },
    }),
    staleTime: 25 * 60 * 1000, // < the backend's 30-min token TTL
  });

  return (
    <Pressable
      onPress={() => {
        void Linking.openURL(appleMapsUrl(lat, lng));
      }}
      accessibilityRole="button"
      accessibilityLabel="Open parked location in Apple Maps"
    >
      <YStack
        height={MAP_HEIGHT}
        rounded="$6"
        overflow="hidden"
        borderWidth={1}
        borderColor="$borderColor"
      >
        {map.data !== undefined ? (
          <Image
            source={{ uri: map.data.url }}
            style={{ flex: 1 }}
            resizeMode="cover"
          />
        ) : (
          <MapBox>
            {map.isError ? (
              <>
                <SfIcon name="map" color="$color10" size={28} />
                <Paragraph color="$color10" fontSize="$2">
                  Map preview unavailable
                </Paragraph>
              </>
            ) : (
              <Spinner color="$color10" />
            )}
          </MapBox>
        )}
      </YStack>
    </Pressable>
  );
}

const PIN_LABEL = encodeURIComponent("My vehicle");

function appleMapsUrl(lat: number, lng: number): string {
  return `https://maps.apple.com/?ll=${String(lat)},${String(lng)}&q=${PIN_LABEL}`;
}

/**
 * Prefer the Google Maps app over its website. openURL (unlike canOpenURL)
 * needs no LSApplicationQueriesSchemes entry, so try the app's scheme and fall
 * back to the web URL when it rejects (app not installed).
 */
async function openGoogleMaps(lat: number, lng: number): Promise<void> {
  const q = `${String(lat)},${String(lng)}`;
  try {
    await Linking.openURL(`comgooglemaps://?q=${q}`);
  } catch {
    await Linking.openURL(
      `https://www.google.com/maps/search/?api=1&query=${q}`,
    );
  }
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
