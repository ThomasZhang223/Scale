import { NativeTabs } from "expo-router/unstable-native-tabs";

// iOS 26 native tabs: Liquid Glass tab bar, minimises on scroll. No bottom
// accessory — the "Full Scale" strip that used to sit above the bar was a
// placeholder for job progress; that now lives on the object detail gauge.
export default function TabsLayout() {
  return (
    <NativeTabs minimizeBehavior="onScrollDown">
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
