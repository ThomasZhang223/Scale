// Shared empty state for the two library screens (Rooms, Objects). Wraps
// @expo/ui's native ContentUnavailableView in its own Host, so a screen just
// drops in <EmptyState /> instead of remembering the Host boilerplate.
import { Host, ContentUnavailableView } from "@expo/ui/swift-ui";
import type { SFSymbol } from "sf-symbols-typescript";
import { StyleSheet } from "react-native";

export type EmptyStateProps = {
  title: string;
  systemImage: SFSymbol;
  description?: string;
};

export function EmptyState({ title, systemImage, description }: EmptyStateProps) {
  return (
    // No matchContents here — ContentUnavailableView wants to fill the
    // space it's given (it centres its icon/title within it), not shrink
    // to its own intrinsic size. The plain flex:1 style already proposes a
    // real RN-measured size down to SwiftUI, which is what we want.
    <Host style={styles.host}>
      <ContentUnavailableView title={title} systemImage={systemImage} description={description} />
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
  },
});
