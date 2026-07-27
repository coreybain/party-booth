import { useRouter } from "expo-router";

import { Button, EmptyState, Screen } from "@/components/ui";

export default function NotFoundScreen() {
  const router = useRouter();

  return (
    <Screen>
      <EmptyState
        icon="help-circle-outline"
        title="This link doesn't go anywhere"
        body="The invite may have been rotated, or the link was cut short when it was shared."
        action={<Button label="Back to the party" onPress={() => router.replace("/")} />}
      />
    </Screen>
  );
}
