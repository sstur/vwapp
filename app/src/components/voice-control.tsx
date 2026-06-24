import { useTransientError } from "@/hooks/use-transient-error";
import { useIosColors } from "@/ios-colors";
import { orpc } from "@/rpc";
import { useMutation } from "@tanstack/react-query";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { EncodingType, readAsStringAsync } from "expo-file-system/legacy";
import { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  Paragraph,
  Spinner,
  Text,
  View,
  XStack,
  YStack,
} from "tamagui";
import { SfIcon } from "./sf-icon";

type Phase = "idle" | "recording" | "thinking" | "speaking";

// The reply stays visible for the whole playback, but at least this long — so a
// one-word answer with sub-second audio doesn't flash by.
const MIN_VISIBLE_MS = 4000;
// How long the "press and hold" hint lingers before fading.
const HINT_MS = 2500;
// A press shorter than this is a tap, not a hold: we don't record — instead we
// hint the user to press and hold.
const MIN_PRESS_MS = 500;
const BARS = 5;

/**
 * Press-and-hold mic button (floats over the dashboard). Records a voice note,
 * sends it to the assistant RPC (transcribe → LLM tool-calls → speech), plays
 * the spoken reply, and shows the text briefly before it fades.
 */
export function VoiceControl({ uuid }: { uuid: string }) {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const recState = useAudioRecorderState(recorder, 80);
  const player = useAudioPlayer(null);
  const playerStatus = useAudioPlayerStatus(player);

  const ios = useIosColors();
  const ask = useMutation(orpc.assistant.ask.mutationOptions());
  const shownError = useTransientError(ask.error);

  const [phase, setPhase] = useState<Phase>("idle");
  const [reply, setReply] = useState<string | null>(null);
  // True between onPressIn and onPressOut, so an async start that finishes after
  // a quick release can immediately stop instead of recording into the void.
  const heldRef = useRef(false);
  // When the press began (onPressIn), to tell a tap from a hold on release.
  const pressStartRef = useRef(0);
  // When the current reply first appeared, to enforce the minimum visible time.
  const shownAtRef = useRef(0);
  // True once we've seen THIS playback actually playing. `useAudioPlayerStatus`
  // retains the last status (incl. didJustFinish) until new audio emits fresh
  // status, so a 2nd+ reply would otherwise see the previous reply's stale
  // "finished" the instant it starts speaking and hide a long reply after just
  // the 4s floor. Reset before each playback; only honor a finish once true.
  const playbackStartedRef = useRef(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFade = () => {
    if (fadeTimer.current !== null) {
      clearTimeout(fadeTimer.current);
      fadeTimer.current = null;
    }
  };
  const hideAfter = (ms: number) => {
    clearFade();
    fadeTimer.current = setTimeout(() => {
      setReply(null);
      setPhase("idle");
    }, ms);
  };

  // Stop playback and clear the reply (used by tap-away and a new recording).
  const dismiss = () => {
    clearFade();
    player.pause();
    setReply(null);
    setPhase("idle");
  };

  // Keep the reply up for the whole playback, then until MIN_VISIBLE_MS elapsed.
  // Gate on playbackStartedRef so a stale didJustFinish from the previous reply
  // can't hide this one early — wait until we've seen this audio actually play.
  useEffect(() => {
    if (phase !== "speaking") return;
    if (playerStatus.playing) playbackStartedRef.current = true;
    if (playbackStartedRef.current && playerStatus.didJustFinish)
      hideAfter(
        Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAtRef.current)),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, playerStatus.playing, playerStatus.didJustFinish]);

  useEffect(
    () => () => {
      clearFade();
    },
    [],
  );

  const startRecording = () => {
    heldRef.current = true;
    pressStartRef.current = Date.now();
    clearFade();
    // Do NOT player.pause() here. Pausing the shared AVAudioSession immediately
    // before re-arming the recorder wedged mic capture after the first turn
    // (the v1.0.13 -> v1.0.14 regression). Re-arming the recorder takes over the
    // session and supersedes any still-playing reply on its own.
    setReply(null);
    void (async () => {
      try {
        const perm = await requestRecordingPermissionsAsync();
        if (!perm.granted) return;
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
        await recorder.prepareToRecordAsync();
        if (!heldRef.current) return; // released during permission/prepare
        recorder.record();
        console.log("[voice] record(); uri=", recorder.uri);
        setPhase("recording");
      } catch {
        setPhase("idle");
      }
    })();
  };

  const stopRecording = () => {
    if (!heldRef.current) return;
    heldRef.current = false;
    const pressMs = Date.now() - pressStartRef.current;
    void (async () => {
      try {
        const wasRecording = recorder.isRecording;
        if (wasRecording) await recorder.stop();
        const st = recorder.getStatus();
        console.log(
          "[voice] stopped uri=",
          recorder.uri,
          "durMs=",
          st.durationMillis,
          "metering=",
          st.metering,
        );
        // A quick tap, not a hold: hint the user and don't transcribe.
        if (pressMs < MIN_PRESS_MS) {
          setReply("Press and hold to talk.");
          setPhase("idle");
          hideAfter(HINT_MS);
          return;
        }
        if (!wasRecording) {
          setPhase("idle");
          return;
        }
        const uri = recorder.uri;
        if (uri === null) {
          setPhase("idle");
          return;
        }
        setPhase("thinking");
        const audioBase64 = await readAsStringAsync(uri, {
          encoding: EncodingType.Base64,
        });
        console.log("[voice] base64 len=", audioBase64.length);
        const res = await ask.mutateAsync({ uuid, audioBase64 });
        // Spoke nothing (empty transcription): abort silently.
        if (res.transcript.trim() === "") {
          setPhase("idle");
          return;
        }
        setReply(res.reply);
        shownAtRef.current = Date.now();
        if (res.audioBase64 !== null) {
          // Aura returns WAV (PCM); play it and keep the text up until it ends
          // (with the MIN_VISIBLE_MS floor, applied on didJustFinish).
          playbackStartedRef.current = false;
          player.replace({ uri: `data:audio/wav;base64,${res.audioBase64}` });
          player.play();
          setPhase("speaking");
        } else {
          // No audio — show the text for the minimum visible window.
          setPhase("idle");
          hideAfter(MIN_VISIBLE_MS);
        }
      } catch {
        setPhase("idle");
      }
    })();
  };

  const busy = phase === "thinking";
  // Map metering dB (~-60 quiet … 0 loud) to 0..1 for the live bars.
  const level =
    recState.metering === undefined
      ? 0.15
      : Math.max(0, Math.min(1, (recState.metering + 60) / 60));

  return (
    // Full-screen layer: passes touches through (box-none) except where a child
    // handles them — so the dashboard stays interactive when idle.
    <View
      position="absolute"
      t={0}
      l={0}
      r={0}
      b={0}
      z={100}
      pointerEvents="box-none"
    >
      {/* While speaking, a tap anywhere kills playback and hides the reply. The
          mic button below is rendered after this, so it stays pressable. */}
      {phase === "speaking" ? (
        <View
          position="absolute"
          t={0}
          l={0}
          r={0}
          b={0}
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel="Stop and dismiss"
        />
      ) : null}

      <YStack
        position="absolute"
        b="$6"
        l={0}
        r={0}
        items="center"
        gap="$2"
        pointerEvents="box-none"
      >
        <AnimatePresence>
          {reply !== null ? (
            <View
              key="reply"
              pointerEvents="none"
              maxW={320}
              bg="$color2"
              borderWidth={1}
              borderColor="$borderColor"
              rounded="$6"
              px="$3.5"
              py="$2.5"
              transition="quick"
              animateOnly={["opacity", "transform"]}
              enterStyle={{ opacity: 0, y: 8 }}
              exitStyle={{ opacity: 0, y: 8 }}
            >
              <Paragraph color="$color" text="center">
                {reply}
              </Paragraph>
            </View>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {shownError ? (
            <Text
              key="voice-error"
              pointerEvents="none"
              color="$red10"
              fontSize="$2"
              transition="quick"
              animateOnly={["opacity"]}
              enterStyle={{ opacity: 0 }}
              exitStyle={{ opacity: 0 }}
            >
              {shownError.message}
            </Text>
          ) : null}
        </AnimatePresence>

        {phase === "recording" ? (
          <XStack
            pointerEvents="none"
            items="flex-end"
            justify="center"
            gap="$1.5"
            height={32}
          >
            {Array.from({ length: BARS }, (_, i) => (
              <View
                key={i}
                width={4}
                rounded="$10"
                style={{ backgroundColor: ios.red }}
                // Per-bar variation so it reads as a waveform, not a single bar.
                height={6 + level * (14 + (i % 3) * 9)}
              />
            ))}
          </XStack>
        ) : null}

        <View
          onPressIn={startRecording}
          onPressOut={stopRecording}
          disabled={busy}
          width={68}
          height={68}
          rounded={9999}
          items="center"
          justify="center"
          style={{
            backgroundColor: phase === "recording" ? ios.red : ios.blue,
          }}
          opacity={busy ? 0.7 : 1}
          pressStyle={{ opacity: 0.85 }}
          shadowColor="$shadowColor"
          shadowRadius={12}
          shadowOpacity={0.3}
          accessibilityRole="button"
          accessibilityLabel="Hold to talk to the assistant"
        >
          {busy ? (
            <Spinner color="white" />
          ) : (
            <SfIcon
              name={phase === "recording" ? "waveform" : "mic.fill"}
              color="white"
              size={28}
            />
          )}
        </View>
      </YStack>
    </View>
  );
}
