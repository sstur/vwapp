import { useFocusEffect, useNavigation } from "expo-router";
import { useCallback, useRef } from "react";
import type { TamaguiElement } from "tamagui";

/**
 * Returns a ref for a Tamagui text field that should focus when its screen
 * settles.
 *
 * `autoFocus` is unreliable on native-stack screens: it fires while the screen
 * is still animating in (a push, or the guard-flip to the login stack), so iOS
 * either drops the focus or attaches the keyboard half-way — the field shows no
 * cursor and the wrong (default password) keyboard for a `secureTextEntry`
 * field until you tap a second time. We instead focus once the navigator's
 * enter transition ends, which places the cursor cleanly and lets iOS pick the
 * right keyboard the first time.
 *
 * The ref is typed as a TamaguiElement (what `<Input ref>` expects); at runtime
 * it's the underlying TextInput, so it has `focus()`.
 */
export function useFocusOnScreen() {
  const ref = useRef<TamaguiElement | null>(null);
  const navigation = useNavigation();
  useFocusEffect(
    useCallback(() => {
      let done = false;
      const focus = () => {
        if (done) return;
        done = true;
        (ref.current as { focus?: () => void } | null)?.focus?.();
      };
      // Pushed screens (and animated guard-flips) emit transitionEnd once the
      // enter animation completes — the safe moment to focus. expo-router's
      // useNavigation isn't typed as a native-stack, so this event (which
      // carries { closing }) isn't in its event map; bridge it with a cast.
      const nav = navigation as unknown as {
        addListener: (
          event: "transitionEnd",
          cb: (e: { data: { closing: boolean } }) => void,
        ) => () => void;
      };
      const unsub = nav.addListener("transitionEnd", (e) => {
        if (!e.data.closing) focus();
      });
      // Fallback for screens presented with no animation (e.g. the initial
      // login route on cold start), which may never emit transitionEnd. The
      // delay is longer than a stack transition so it never pre-empts the
      // listener above for a pushed screen.
      const timer = setTimeout(focus, 500);
      return () => {
        unsub();
        clearTimeout(timer);
      };
    }, [navigation]),
  );
  return ref;
}
