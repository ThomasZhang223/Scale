// Shared empty state for the two library screens (Rooms, Objects) and any
// screen-section that needs one. Wraps @expo/ui's native
// ContentUnavailableView — nothing more.
//
// Deliberately does NOT wrap itself in a Host: @expo/ui's SwiftUI tree
// can't nest a Host inside it (only plain RN can nest a Host as a sibling
// of other RN views), and this needs to work both as a screen's sole
// content (Rooms, wrapped in its own Host by the caller) and nested next
// to other SwiftUI content on the same screen (Objects, next to its filter
// Picker in the same Host/VStack). See PaletteSwatches.tsx for the same
// nesting rule from the other direction.
import { ContentUnavailableView } from "@expo/ui/swift-ui";
import type { SFSymbol } from "sf-symbols-typescript";

export type EmptyStateProps = {
  title: string;
  systemImage: SFSymbol;
  description?: string;
};

export function EmptyState({ title, systemImage, description }: EmptyStateProps) {
  return <ContentUnavailableView title={title} systemImage={systemImage} description={description} />;
}
