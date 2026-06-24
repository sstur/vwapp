import { IosButton } from "@/components/ios-list";
import { useFocusOnScreen } from "@/hooks/use-focus-on-screen";
import { useLoginFlow } from "@/providers/login-flow";
import { orpc } from "@/rpc";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { H1, Input, Paragraph, Text, YStack } from "tamagui";

/**
 * Step 2 of sign-in: the S-PIN. Credentials were already validated on the
 * previous screen and live in the login-flow context (in memory only). This is
 * the step that actually logs in (auth.login persists the account, always with
 * the S-PIN). Going back or otherwise leaving clears the held credentials, so a
 * cancelled flow leaves the user fully logged out with nothing stored.
 */
export default function LoginPin() {
  const queryClient = useQueryClient();
  const { credentials, clear } = useLoginFlow();
  const [spin, setSpin] = useState("");
  const pinRef = useFocusOnScreen();

  // Drop the held credentials whenever we leave this screen — on success the
  // guard-flip unmounts it (after loggedIn flips, so the redirect below won't
  // fire), and on a back/cancel it abandons the flow.
  useEffect(() => clear, [clear]);

  const login = useMutation(
    orpc.auth.login.mutationOptions({
      onSuccess: async () => {
        // Flipping auth.me to logged-in makes the layout guard swap to the app.
        await queryClient.invalidateQueries();
      },
    }),
  );

  // Reached without validated credentials (e.g. a reload or deep link landing
  // here): there's nothing to submit — start the flow over.
  if (credentials === null) return <Redirect href="/login" />;

  const canSubmit = /^\d{4,6}$/.test(spin) && !login.isPending;
  const submit = () => {
    if (canSubmit) login.mutate({ ...credentials, spin });
  };

  return (
    <YStack flex={1} bg="$background">
      <KeyboardAwareScrollView
        mode="layout"
        bottomOffset={16}
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          padding: 16,
          gap: 16,
        }}
      >
        <H1 size="$9" color="$color">
          Enter PIN
        </H1>
        <Paragraph color="$color10">Your myVW security PIN.</Paragraph>
        {/* textContentType="none": keep iOS from treating this secure field as a
            password and offering to save it as the credential. */}
        <Input
          ref={pinRef}
          size="$5"
          placeholder="PIN"
          secureTextEntry
          keyboardType="number-pad"
          textContentType="none"
          autoComplete="off"
          maxLength={6}
          returnKeyType="go"
          onSubmitEditing={submit}
          value={spin}
          onChangeText={setSpin}
        />
        {login.error ? (
          <Text
            selectable
            color="$red10"
            transition="quick"
            animateOnly={["opacity"]}
            enterStyle={{ opacity: 0 }}
          >
            {login.error.message}
          </Text>
        ) : null}
        <IosButton
          full
          tone="blue"
          disabled={!canSubmit}
          onPress={submit}
          label={login.isPending ? "Signing in…" : "Sign in"}
        />
      </KeyboardAwareScrollView>
    </YStack>
  );
}
