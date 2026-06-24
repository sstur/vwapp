/**
 * Full-screen states shown before the navigator mounts: the spinner that sits
 * under the native splash while the session resolves, and the error state
 * when it can't be resolved (server or Instant unreachable).
 */
import { H2, Paragraph, Spinner, YStack } from "tamagui";
import { IosButton } from "./ios-list";

export function BootLoading() {
  return (
    <YStack flex={1} bg="$background" items="center" justify="center">
      <Spinner size="large" color="$color" />
    </YStack>
  );
}

export function BootError({
  message,
  retrying,
  onRetry,
  onDiscardLocalAuth,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
  onDiscardLocalAuth: () => void;
}) {
  return (
    <YStack
      flex={1}
      bg="$background"
      items="center"
      justify="center"
      p="$5"
      gap="$4"
    >
      <H2 color="$color" text="center">
        Can&apos;t reach the server
      </H2>
      <Paragraph selectable color="$color10" text="center">
        {message}
      </Paragraph>
      <IosButton
        tone="blue"
        disabled={retrying}
        onPress={onRetry}
        label={retrying ? "Trying…" : "Try again"}
      />
      {/* Escape hatch: forget this device's identity (server session survives). */}
      <IosButton
        tone="blue"
        variant="plain"
        onPress={onDiscardLocalAuth}
        label="Sign out on this device"
      />
    </YStack>
  );
}
