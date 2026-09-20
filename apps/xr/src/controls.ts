/*
 * The controller mapping: one table, and the one rule that decides what the thumbstick does.
 *
 * Its own module for two reasons. The next change to the mapping is one edit, in one place. And
 * interaction.ts uses TypeScript parameter properties, which node's strip-only loader refuses,
 * so nothing in it can be imported by a test — the rule below can only be tested from here.
 *
 * Indices are the WebXR xr-standard gamepad mapping. Which hand a control belongs to comes from
 * `inputSource.handedness` and never from the controller's index in the array: that order is
 * whatever the runtime reports and it changes between sessions.
 *
 *   trigger (selectstart)     a tile, a window, or grab whatever the ray is on
 *   RIGHT stick left/right    turns the object held or pointed at; snap-turns the view when on none
 *   RIGHT stick forward/back  pushes and pulls a window while one is being dragged
 *   LEFT stick                glides
 *   A  (right, buttons[4])    deletes the object held or pointed at. FINAL: nothing brings it back
 *   B  (right, buttons[5])    picks up what the ray is on; press again and it falls onto what is under it
 *   X/Y (left, same indices)  unbound. They turned the held object a quarter turn per press; the
 *                             right stick does that now, smoothly, which is what was asked for.
 */

export const STICK_X = 2;
export const STICK_Y = 3;
export const BUTTON_A = 4;
export const BUTTON_B = 5;

/** Metres above the floor a B press raises an object to. */
export const LIFT_HEIGHT = 1.0;

export interface StickHand {
  draggingWindow: boolean;
  handedness?: string;
  holding: boolean;
  pointingAt: string | null;
}

/**
 * What the thumbstick does this frame, for one hand. Three cases that never overlap:
 *
 *   window      a window is in this hand: forward and back push and pull it
 *   object      this is the right hand and it holds or points at an object: left and right turn it
 *   locomotion  neither: the left stick glides, the right stick snap-turns the view
 *
 * So aiming at an object costs the snap turn while you aim at it. That is the trade the mapping
 * asks for: the stick belongs to whatever you are aiming at.
 */
/**
 * Whether A and B act at all this frame.
 *
 * The ray does not stop at the interface. A window, a panel button and a palette tile all stand
 * between the person and the room, and the ray carries on through them to whatever object is
 * behind — so aiming at any of those and pressing A deletes something the person cannot see, and
 * cannot get back. Holding a window is the same thing one step on: the window is what you aim at.
 *
 * The right hand only, for the reason in the table above.
 */
export function objectButtonsActive(hand: {
  draggingWindow: boolean;
  handedness?: string;
  /** The ray is on a panel button, a window's handle or a palette tile. */
  rayOnUi?: boolean;
}): boolean {
  return !hand.draggingWindow && !hand.rayOnUi && hand.handedness === 'right';
}

export function stickUse(hand: StickHand): 'window' | 'object' | 'locomotion' {
  if (hand.draggingWindow) return 'window';
  if (hand.handedness === 'right' && (hand.holding || hand.pointingAt !== null)) return 'object';
  return 'locomotion';
}
