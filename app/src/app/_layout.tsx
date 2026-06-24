import { BootError, BootLoading } from "@/components/boot-screens";
import { LoginFlowProvider } from "@/providers/login-flow";
import { SessionProvider, useSession } from "@/providers/session-provider";
import { ThemeProvider, useThemeToggle } from "@/providers/theme-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavThemeProvider,
  Stack,
} from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useTheme } from "tamagui";

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootNavigator() {
  const { isLoading, loggedIn, initError, retry, retrying, discardLocalAuth } =
    useSession();
  // Headers are hidden by default here, but screens that opt back in
  // (+not-found) must still follow the in-app theme.
  const theme = useTheme();
  const { pref } = useThemeToggle();

  // The navigator's container view (visible behind screens, e.g. on an
  // over-swiped back gesture) is painted from the navigation theme, which
  // otherwise stays at expo-router's light default regardless of the in-app
  // theme — repaint it with the Tamagui colors.
  const navBase = pref === "dark" ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...navBase,
    colors: {
      ...navBase.colors,
      background: theme.background.val,
      card: theme.background.val,
      text: theme.color.val,
      border: theme.borderColor.val,
    },
  };

  // Splash stays up until the session is resolved (or failed); whatever we
  // render below is the first thing the user actually sees.
  useEffect(() => {
    if (!isLoading) void SplashScreen.hideAsync();
  }, [isLoading]);

  // Spinner under the splash — visible in Expo Go, where splash control is
  // unreliable, and on slow connections after the splash gives way.
  if (isLoading) return <BootLoading />;

  // Initial auth state unknown (server/Instant unreachable): keep the saved
  // token, offer retry — never silently fall through to the login screen.
  if (initError !== null)
    return (
      <BootError
        message={initError}
        retrying={retrying}
        onRetry={retry}
        onDiscardLocalAuth={discardLocalAuth}
      />
    );

  // The navigator mounts only once the session is known, so the cold-start
  // navigation state is the final one: no login-screen flash, no transition
  // animation. Guard flips at runtime (sign-in/sign-out) animate normally,
  // and Stack.Protected removes the inactive screen from history entirely.
  return (
    <NavThemeProvider value={navTheme}>
      <Stack
        screenOptions={{
          headerShown: false,
          headerTitleStyle: { color: theme.color.val },
          headerTintColor: theme.color.val,
          headerStyle: { backgroundColor: theme.background.val },
          // The back label would otherwise read the route group name, "(app)".
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Protected guard={loggedIn}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={!loggedIn}>
          {/* `login` declared first so it's the group's initial route; the
              S-PIN screen is pushed on top after credentials validate. */}
          <Stack.Screen name="login" />
          <Stack.Screen
            name="login-pin"
            options={{
              headerShown: true,
              headerTransparent: true,
              headerTitle: "",
            }}
          />
        </Stack.Protected>
      </Stack>
    </NavThemeProvider>
  );
}

export default function RootLayout() {
  return (
    // GestureHandlerRootView must wrap the whole app (and fill it) for
    // react-native-gesture-handler gestures — e.g. the swipe-to-action rows on
    // the Messages screen — to receive touches.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <SafeAreaProvider>
          <KeyboardProvider>
            <QueryClientProvider client={queryClient}>
              <SessionProvider>
                <LoginFlowProvider>
                  <RootNavigator />
                </LoginFlowProvider>
              </SessionProvider>
            </QueryClientProvider>
          </KeyboardProvider>
        </SafeAreaProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
