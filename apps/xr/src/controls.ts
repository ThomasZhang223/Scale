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

/** How long an armed object stays armed. Long enough to look at it, short enough to forget. */
export const DELETE_ARM_MS = 2000;

/** The object A has armed, and when. */
export interface Armed {
  id: string;
  at: number;
}

/**
 * A press of A: what it arms, and what it deletes.
 *
 * Delete takes two presses on the same object, because four separate bugs in one night all had
 * the same shape — A acting on something the person could not see. Guarding each way that could
 * happen is a list of the holes found so far. Requiring the object to be marked, and the mark to
 * be looked at, closes the class: nothing goes without being shown first.
 *
 * `id` is the object this press is on, or null when the press is on the interface, on the room,
 * or on nothing. A null press only ever disarms.
 */
export function armDelete(
  armed: Armed | null,
  press: { id: string | null; now: number },
): { armed: Armed | null; deleteId: string | null } {
  if (press.id === null) return { armed: null, deleteId: null };
  const sameObject = armed?.id === press.id;
  const inTime = armed !== null && press.now - armed.at <= DELETE_ARM_MS;
  // A second press on the same object, in time, is the only thing that deletes. A press on a
  // different object arms THAT one — it never inherits the armed state of the last.
  if (sameObject && inTime) return { armed: null, deleteId: press.id };
  return { armed: { id: press.id, at: press.now }, deleteId: null };
}

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
