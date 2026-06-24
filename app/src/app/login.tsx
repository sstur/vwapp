import { IosButton } from "@/components/ios-list";
import { useFocusOnScreen } from "@/hooks/use-focus-on-screen";
import { useLoginFlow } from "@/providers/login-flow";
import { orpc } from "@/rpc";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { H1, Input, Paragraph, Text, YStack } from "tamagui";

/**
 * Step 1 of sign-in: VW account credentials. Validates username + password with
 * VW (auth.checkCredentials — no login/persist yet) so a wrong password is
 * caught here, then hands them to the S-PIN screen. Kept to a clean
 * username + password form (no second secure field) so iOS offers to fill the
 * saved email and to save the credential after submit.
 */
export default function Login() {
  const router = useRouter();
  const { setCredentials } = useLoginFlow();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const emailRef = useFocusOnScreen();

  const check = useMutation(
    orpc.auth.checkCredentials.mutationOptions({
      onSuccess: () => {
        setCredentials({ username, password });
        router.push("/login-pin");
      },
    }),
  );

  const canSubmit = username !== "" && password !== "" && !check.isPending;
  const submit = () => {
    if (canSubmit) check.mutate({ username, password });
  };

  return (
    <YStack flex={1} bg="$background">
      {/* mode="layout" sizes a spacer to the keyboard instead of growing the
          scrollable area, so the centered form reflows into the remaining
          space with no excess scroll range above or below. */}
      {/* No contentInsetAdjustmentBehavior here: on iOS "automatic" also
          counts the keyboard as an inset, stacking a second scroll range on
          top of the layout spacer. No header on this screen, so nothing else
          needs it. */}
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
        {/* Generic VW sign-in — this account works for any myVW vehicle
            (ID. Buzz, ID.4, …), so the title must not assume a model. */}
        <H1 size="$9" color="$color">
          Sign in
        </H1>
        <Paragraph color="$color10">
          Use your Volkswagen (myVW) account.
        </Paragraph>
        {/* textContentType username/password (iOS) + autoComplete (Android) so
            the OS offers to fill the saved email and to save the credential
            after a successful sign-in. The email field is the "username" half
            of the pair iOS associates with the password. */}
        <Input
          ref={emailRef}
          size="$5"
          placeholder="Email"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          autoComplete="email"
          returnKeyType="next"
          value={username}
          onChangeText={setUsername}
        />
        <Input
          size="$5"
          placeholder="Password"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          autoComplete="current-password"
          returnKeyType="go"
          onSubmitEditing={submit}
          value={password}
          onChangeText={setPassword}
        />
        {check.error ? (
          <Text
            selectable
            color="$red10"
            transition="quick"
            animateOnly={["opacity"]}
            enterStyle={{ opacity: 0 }}
          >
            {check.error.message}
          </Text>
        ) : null}
        <IosButton
          full
          tone="blue"
          disabled={!canSubmit}
          onPress={submit}
          label={check.isPending ? "Checking…" : "Continue"}
        />
      </KeyboardAwareScrollView>
    </YStack>
  );
}
