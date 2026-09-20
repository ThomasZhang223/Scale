import { NativeTabs } from "expo-router/unstable-native-tabs";
import { Text } from "react-native";

import { Glass } from "../../src/theme/Glass";
import { spacing } from "../../src/theme/tokens";

// ceiling: static text. This becomes the "generating… 40%" job-progress
// strip once a job-tracking store exists — that store reads SSE `job` events
// over src/lib/sse.ts, which is Panel B's file. Wire it in there, not here.
function JobProgressAccessory() {
  return (
    <Glass style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
      <Text>Full Scale</Text>
    </Glass>
  );
}

export default function TabsLayout() {
  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <NativeTabs.BottomAccessory>
        <JobProgressAccessory />
      </NativeTabs.BottomAccessory>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Room</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="house" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="scanned">
        <NativeTabs.Trigger.Label>Scanned</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="cube" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="furniture">
        <NativeTabs.Trigger.Label>Furniture</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="sofa" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="capture">
        <NativeTabs.Trigger.Label>Capture</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="viewfinder" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="headset">
        <NativeTabs.Trigger.Label>Headset</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="visionpro" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
