import { useIosColors } from "@/ios-colors";
import { Stack } from "expo-router";
import { useTheme } from "tamagui";

// expo-router orders explicitly-declared <Stack.Screen>s FIRST (in declaration
// order), then appends the remaining file routes sorted by initialRouteName —
// and it picks the stack's initial route from the first child, NOT from an
// initialRouteName prop. So declaring only `climate` below made it route 0,
// landing the post-login guard-flip on the full-screen climate form sheet.
// Declaring `index` first puts the dashboard at route 0; initialRouteName is
// kept as belt-and-suspenders (it only governs the undeclared remainder).
export const unstable_settings = {
  initialRouteName: "index",
};

export default function AppLayout() {
  // Native headers can't consume Tamagui tokens; resolve them so the header
  // follows the in-app theme override (PlatformColor would track the system).
  const theme = useTheme();
  const ios = useIosColors();
  const color = theme.color.val;

  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerLargeTitleShadowVisible: false,
        headerTitleStyle: { color },
        headerLargeTitleStyle: { color },
        headerTintColor: color,
        // Screens paint their background here so each route can keep a
        // ScrollView as its first child — UIKit requires that to drive
        // large-title collapse on scroll. The iOS grouped-table background is
        // the app-wide default so every screen's cards sit on it.
        contentStyle: { backgroundColor: ios.groupedBg },
        // Standard iOS bar: invisible while the large title rests over the
        // content; once scrolled, the system's scroll-edge effect takes over
        // (no headerBlurEffect — it overlaps that effect on iOS 26).
        // Android supports no transparency — give it a solid bar.
        ...(process.env.EXPO_OS === "ios"
          ? {
              headerTransparent: true,
              headerLargeStyle: { backgroundColor: "transparent" },
            }
          : {
              headerStyle: { backgroundColor: theme.background.val },
            }),
      }}
    >
      {/* Declared first so the dashboard is the stack's initial route — see the
          unstable_settings note above. */}
      <Stack.Screen name="index" />
      {/* Climate Start/Adjust as a native iOS form sheet (UIKit sheet) so its
          drag-to-dismiss coordinates with the native time wheel inside — an
          RN-gesture-handler sheet fights it. fitToContents sizes it to the
          form; contentStyle paints the surface (native sheets don't inherit
          the Tamagui theme). */}
      <Stack.Screen
        name="climate"
        options={{
          headerShown: false,
          presentation: "formSheet",
          sheetAllowedDetents: "fitToContents",
          sheetGrabberVisible: true,
          sheetCornerRadius: 24,
          // A solid frosted-material grey (ios.sheet): an elevated sheet surface
          // that reads as iOS's frosted glass and gives the content enough
          // contrast, without an actual (see-through) blur.
          contentStyle: { backgroundColor: ios.sheet },
        }}
      />
    </Stack>
  );
}
