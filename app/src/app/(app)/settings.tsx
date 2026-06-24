import { IosGroup, IosRow } from "@/components/ios-list";
import { useThemeToggle } from "@/providers/theme-provider";
import { API_URL } from "@/rpc";
import { Host, Toggle } from "@expo/ui/swift-ui";
import Constants from "expo-constants";
import { Stack } from "expo-router";
import { ScrollView } from "react-native";

/**
 * App settings: appearance, plus the connection/build facts that matter when
 * debugging "which app am I talking to?" (API host differs between dev and
 * prod; version identifies the build a bug report came from).
 */
export default function SettingsScreen() {
  const { pref, toggle } = useThemeToggle();
  const dark = pref === "dark";

  return (
    <>
      <Stack.Screen options={{ title: "Settings", headerBackTitle: "Home" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
        <IosGroup>
          <IosRow
            label="Dark mode"
            accessory={
              <Host matchContents colorScheme={pref}>
                <Toggle
                  isOn={dark}
                  onIsOnChange={(isOn) => {
                    if (isOn !== dark) toggle();
                  }}
                />
              </Host>
            }
          />
        </IosGroup>

        <IosGroup>
          {/* Not new URL(...).origin — Hermes' URL support is spotty. */}
          <IosRow label="API host" value={API_URL.replace(/\/rpc\/?$/, "")} />
          <IosRow
            label="Version"
            value={Constants.expoConfig?.version ?? "unknown"}
          />
        </IosGroup>
      </ScrollView>
    </>
  );
}
