import { db } from "@/db";
import { htmlToText } from "@/html";
import { useIosColors } from "@/ios-colors";
import { orpc } from "@/rpc";
import { useMutation } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { Text as RNText, ScrollView } from "react-native";
import { Paragraph, YStack } from "tamagui";

/**
 * A single message-center message in full, read from InstantDB by messageId.
 * Marks the message read (our override) on open via the server; the list clears
 * its unread dot through the live query.
 */
export default function MessageDetail() {
  const ios = useIosColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = db.useQuery({ messages: { $: { where: { messageId: id } } } });
  const message = q.data?.messages[0];

  const setRead = useMutation(orpc.vehicle.setMessageRead.mutationOptions());
  const { mutate: setReadMutate } = setRead;
  useEffect(() => {
    if (id) setReadMutate({ messageId: id, read: true });
  }, [id, setReadMutate]);

  return (
    <>
      <Stack.Screen
        options={{
          title: "",
          headerLargeTitle: false,
          headerBackTitle: "Messages",
          contentStyle: { backgroundColor: ios.systemBackground },
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 8 }}
      >
        {message === undefined ? (
          <Paragraph color="$color10">Message not found.</Paragraph>
        ) : (
          <YStack gap="$2">
            <RNText
              selectable
              style={{ fontSize: 22, fontWeight: "700", color: ios.label }}
            >
              {message.title}
            </RNText>
            {message.at != null ? (
              <RNText style={{ fontSize: 13, color: ios.secondaryLabel }}>
                {formatDate(message.at)}
              </RNText>
            ) : null}
            {message.body != null && message.body !== "" ? (
              <RNText
                selectable
                style={{
                  fontSize: 17,
                  lineHeight: 24,
                  color: ios.label,
                  marginTop: 8,
                }}
              >
                {htmlToText(message.body)}
              </RNText>
            ) : null}
          </YStack>
        )}
      </ScrollView>
    </>
  );
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
