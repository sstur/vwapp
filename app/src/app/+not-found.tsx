import { IosButton } from "@/components/ios-list";
import { Stack, useRouter } from "expo-router";
import { H2, YStack } from "tamagui";

export default function NotFound() {
  const router = useRouter();
  return (
    <>
      {/* The root stack hides headers; opt back in so the title actually shows. */}
      <Stack.Screen options={{ headerShown: true, title: "Not found" }} />
      <YStack
        flex={1}
        bg="$background"
        justify="center"
        items="center"
        gap="$4"
        p="$4"
      >
        <H2 color="$color">This screen doesn&apos;t exist.</H2>
        <IosButton
          tone="blue"
          label="Go home"
          onPress={() => {
            router.replace("/");
          }}
        />
      </YStack>
    </>
  );
}
