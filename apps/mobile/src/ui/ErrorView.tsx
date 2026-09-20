// A visible failure state — CLAUDE.md, "Fail loud": a network or schema
// error is shown to the person looking at the screen, never swallowed into
// a blank or stuck-loading view. Shared by every screen that fetches.
import { Button, ContentUnavailableView, VStack } from "@expo/ui/swift-ui";

import { GlassHost } from "./glass";
import { StyleSheet } from "react-native";

export type ErrorViewProps = {
  message: string;
  onRetry?: () => void;
};

export function ErrorView({ message, onRetry }: ErrorViewProps) {
  return (
    <GlassHost style={styles.host}>
      <VStack spacing={12}>
        <ContentUnavailableView
          title="Couldn't load this"
          systemImage="exclamationmark.triangle"
          description={message}
        />
        {onRetry ? <Button label="Try again" onPress={onRetry} /> : null}
      </VStack>
    </GlassHost>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
  },
});
