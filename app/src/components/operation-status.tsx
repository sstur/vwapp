import { db } from "@/db";
import { Paragraph, Spinner, Text, XStack } from "tamagui";
import { IosCard } from "./ios-list";

/** Progress survives app restarts because the cloud coordinator writes it to InstantDB. */
export function OperationStatus({ vehicleId }: { vehicleId: string }) {
  const query = db.useQuery({
    vehicleOperations: {
      $: {
        where: { "vehicle.id": vehicleId },
        order: { createdAt: "desc" },
        limit: 1,
      },
    },
  });
  const op = query.data?.vehicleOperations[0];
  if (!op || op.state === "succeeded") return null;
  const pending = op.state === "running" || op.state === "queued";
  return (
    <IosCard p="$4" gap="$2">
      <XStack gap="$2" items="center">
        {pending ? <Spinner color="$color10" /> : null}
        <Paragraph color={pending ? "$color" : "$red10"}>
          {pending
            ? op.state === "queued"
              ? "Your request is waiting for the previous one to finish."
              : "Working on your request… You can leave this screen."
            : (op.message ?? "The request could not be completed.")}
        </Paragraph>
      </XStack>
      {!pending ? (
        <Text selectable color="$color10" fontSize="$1">
          {op.errorCode} · {op.id}
        </Text>
      ) : null}
    </IosCard>
  );
}
