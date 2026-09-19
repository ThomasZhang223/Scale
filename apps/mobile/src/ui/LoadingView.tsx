// A centred native spinner, for the brief window between a screen mounting
// and its fixture-backed fetch resolving. Shared by both library screens
// and both detail screens — four call sites.
import { Host, ProgressView, Spacer, VStack } from "@expo/ui/swift-ui";
import { StyleSheet } from "react-native";

export function LoadingView() {
  return (
    <Host style={styles.host} useViewportSizeMeasurement>
      {/* SwiftUI centres a VStack's children on the cross axis by default;
          a leading and trailing Spacer is the standard way to also centre
          on the main axis, without guessing at a frame(maxHeight: .infinity)
          binding from the JS side. */}
      <VStack>
        <Spacer />
        <ProgressView />
        <Spacer />
      </VStack>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
  },
});
