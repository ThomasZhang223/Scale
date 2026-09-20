import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { AgentClient, type Proposal } from './agent.ts';
import { ProposalApplier } from './apply.ts';
import { Ghosts } from './ghosts.ts';
import { Palette, type PaletteItem } from './palette.ts';
import { createPhysics } from './physics.ts';
import { buildRoomFromScan } from './roomScan.ts';
import { fromPlacement, toPlacement } from './placements.ts';

/* Tests 1–8 from docs/agent/04_HEADSET.md and H1–H3 from 09, against the golden fixtures. */

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf-8'));
const FIX = '../../../services/agent/fixtures/';
const timeline = read(`${FIX}agent-request-demo.json`);
const proposal: Proposal = read(`${FIX}pipeline/proposal.json`);
const vectors = read(`${FIX}pipeline/conversion-vectors.json`);
const sampleRoom = read('../public/room-scan.json');

const near = (a: number, b: number, what: string, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${what}: expected ${b}, got ${a}`);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake agent server that walks the stub timeline one step per poll. */
function fakeServer(opts: { acceptStatus?: number; fail?: boolean } = {}) {
  let polls = 0;
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(/^.*\/v1\/agent\/[^/]+/, '')}`);
    if (url.endsWith('/state')) return json({ versionId: 'ver_base' });
    if (url.endsWith('/requests') && method === 'POST') return json({ requestId: 'stub-req-1' }, 202);
    if (url.endsWith('/requests/stub-req-1')) {
      if (opts.fail) return json({ state: 'failed', log: [timeline.steps[0].log], error: 'The layout solver isn’t reachable right now.' });
      const index = Math.min(polls++, timeline.steps.length - 1);
      const shown = timeline.steps.slice(0, index + 1);
      const last = shown[shown.length - 1];
      return json({ state: last.state, message: last.message, log: shown.map((s: { log: unknown }, i: number) => ({ at: `t${i}`, ...(s.log as object) })), proposal: index === timeline.steps.length - 1 ? proposal : undefined });
    }
    if (url.endsWith('/accept')) return opts.acceptStatus === 409 ? json({ error: 'the room changed', currentVersionId: 'ver_new' }, 409) : json({ versionId: 'ver_accepted' });
    if (url.endsWith('/reject')) return json({ ok: true });
    if (url.endsWith('/undo')) return json({ versionId: 'ver_base' });
    return json({ error: 'not found' }, 404);
  };
  return { fetchFn, calls };
}

async function drive(client: AgentClient, maxPolls = 12) {
  for (let i = 0; i < maxPolls && client.snapshot.state === 'working'; i++) await client.poll();
}

test('1: the state machine walks the stub timeline: idle → working → proposed, every log line once, in order', async () => {
  const server = fakeServer();
  const states: string[] = [];
  const client = new AgentClient({ roomId: 'demo', fetch: server.fetchFn, openEvents: () => () => {}, onChange: (s) => states.push(s.state) });
  assert.equal(client.snapshot.state, 'idle');
  await client.request({ preset: 'reading_corner', pins: [] });
  assert.equal(client.snapshot.state, 'working');
  await drive(client);
  assert.equal(client.snapshot.state, 'proposed');
  assert.deepEqual(client.snapshot.log.map((e) => e.message), timeline.steps.map((s: { log: { message: string } }) => s.log.message));
  assert.equal(client.snapshot.proposal?.requestId, 'stub-req-1');
  assert.deepEqual([...new Set(states)], ['working', 'proposed']);
});

test('2: the feed and polling deliver the same proposal; it is handled once', async () => {
  const server = fakeServer();
  let feed: ((event: string, data: unknown) => void) | null = null;
  let proposals = 0;
  const client = new AgentClient({ roomId: 'demo', fetch: server.fetchFn, openEvents: (_url, on) => { feed = on; return () => {}; }, onChange: (s) => { if (s.state === 'proposed') proposals++; } });
  await client.request({ preset: 'reading_corner', pins: [] });
  feed!('agent.log', { requestId: 'stub-req-1', entry: { at: 't0', ...timeline.steps[0].log } });
  feed!('agent.proposal', { requestId: 'stub-req-1', proposal });
  assert.equal(client.snapshot.state, 'proposed');
  await client.poll(); // the poll arrives late with the same proposal
  feed!('agent.proposal', { requestId: 'stub-req-1', proposal });
  assert.equal(proposals, 1);
  assert.equal(client.snapshot.log.filter((e) => e.message === timeline.steps[0].log.message).length, 1, 'no duplicate log line');
});

test('3: accept → 409 adopts the server\'s version and applies the proposal anyway, with no "room changed" state', async () => {
  const server = fakeServer({ acceptStatus: 409 });
  const client = new AgentClient({ roomId: 'demo', fetch: server.fetchFn, openEvents: () => () => {} });
  await client.request({ preset: 'clear_door', pins: [] });
  await drive(client);
  const proposal = client.snapshot.proposal;
  assert.equal(await client.accept(), proposal);
  assert.equal(client.snapshot.state, 'applying');
  assert.equal(client.snapshot.currentVersionId, 'ver_new');
  assert.ok(!/room changed/i.test(client.snapshot.status ?? ''));
});

test('failure and offline: a failed request reports the message; no server gives the sample proposal', async () => {
  const failing = new AgentClient({ roomId: 'demo', fetch: fakeServer({ fail: true }).fetchFn, openEvents: () => () => {} });
  await failing.request({ preset: 'clear_door', pins: [] });
  await drive(failing);
  assert.equal(failing.snapshot.state, 'failed');
  assert.match(failing.snapshot.error ?? '', /solver/);

  const offline = new AgentClient({ roomId: 'demo', fetch: async () => { throw new Error('ECONNREFUSED'); }, openEvents: () => () => {}, offlineProposal: proposal });
  await offline.request({ preset: 'clear_door', pins: [] });
  assert.equal(offline.snapshot.state, 'proposed');
  assert.equal(offline.snapshot.offline, true);
  assert.match(offline.snapshot.status, /Offline/);
});

test('4 + H1 + H2: proposal placements round-trip through placements.ts; one ghost per moved object', () => {
  const built = buildRoomFromScan(sampleRoom); // offset (-0.7, 1.4, -0.9)
  for (const v of vectors.vectors.filter((x: { version?: unknown }) => x.version)) {
    const layout = fromPlacement({ placementId: 'p', objectId: 'o', p: v.version.p, yawDeg: v.version.yawDeg, scale: 1, lockedToWallId: null, flags: [] }, built.offset);
    near(layout.position[0], v.scene.x, `${v.name} x`); near(layout.position[2], v.scene.z, `${v.name} z`); near(layout.rotationY, v.scene.rotY, `${v.name} rotY`);
    const back = toPlacement(layout, built.offset);
    near(back.p[0], v.version.p[0], `${v.name} back x`); near(back.p[2], v.version.p[2], `${v.name} back z`);
  }
  const ghosts = new Ghosts();
  const node = new THREE.Group();
  ghosts.show(proposal.moves.map((m) => {
    const to = fromPlacement(m.to, built.offset);
    const from = fromPlacement(m.from, built.offset);
    return { node, from: from.position, to: to.position, rotY: to.rotationY, size: new THREE.Vector3(1, 0.5, 1) };
  }));
  assert.equal(ghosts.count, 2, 'sofa and chair move; table and storage do not');
  const chairGhost = ghosts.group.children.filter((c) => c.userData.ghost)[1];
  near(chairGhost.position.x, -1.17, 'chair ghost x'); near(chairGhost.position.z, -1.42, 'chair ghost z'); near(chairGhost.rotation.y, 0, 'chair ghost yaw');
  ghosts.clear();
  assert.equal(ghosts.count, 0);
});

test('5 + H3: applying the proposal with physics: sofa and chair arrive within 2 cm / 2°, swapping objects do not jam', async () => {
  const built = buildRoomFromScan(sampleRoom);
  const physics = await createPhysics(new THREE.Scene());
  physics.setRoom(built);
  const sofa = new THREE.Group(), chair = new THREE.Group();
  const sofaSize = new THREE.Vector3(2.19, 0.79, 1.02), chairSize = new THREE.Vector3(0.83, 0.69, 0.57);
  // Detected boxes for the sofa and chair are replaced by the real objects.
  for (const o of built.objects) if (o.category === 'sofa' || o.category === 'chair') physics.removeDetected(o.identifier);
  physics.addObject('sofa', sofa, sofaSize, new Float32Array(), { x: 0, z: -1.24 }, 0, 0);
  physics.addObject('chair', chair, chairSize, new Float32Array(), { x: 1.4, z: 0.3 }, -Math.PI / 2, 0);
  for (let i = 0; i < 30; i++) physics.step(1 / 60);

  const applier = new ProposalApplier(physics);
  const results: { arrived: string[]; stuck: string[] }[] = [];
  const targets = proposal.moves.map((m) => ({ id: m.objectId.replace('obj_', ''), ...fromPlacement(m.to, built.offset) }));
  applier.start(targets.map((t) => ({ id: t.id, x: t.position[0], z: t.position[2], rotY: t.rotationY })), [], (r) => { results.push(r); });
  for (let i = 0; i < 240 && !results.length; i++) { applier.update(1 / 60); physics.step(1 / 60); }
  assert.ok(results.length, 'finished within 4 s');
  assert.deepEqual(results[0].arrived.sort(), ['chair', 'sofa']);
  assert.deepEqual(results[0].stuck, []);
  near(sofa.position.x, 0.95, 'sofa x', 0.02); near(chair.position.x, -1.17, 'chair x', 0.02); near(chair.position.z, -1.42, 'chair z', 0.02);
  near(physics.rotationY('chair'), 0, 'chair turned to face the room', 0.04);

  // Two boxes swapping places: with movers ignoring each other they both arrive.
  const a = new THREE.Group(), b = new THREE.Group();
  const s = new THREE.Vector3(0.5, 0.5, 0.5);
  physics.addObject('a', a, s, new Float32Array(), { x: -1.0, z: 1.0 }, 0, 0);
  physics.addObject('b', b, s, new Float32Array(), { x: 1.0, z: 1.0 }, 0, 0);
  for (let i = 0; i < 30; i++) physics.step(1 / 60);
  const swaps: { arrived: string[]; stuck: string[] }[] = [];
  applier.start([{ id: 'a', x: 1.0, z: 1.0, rotY: 0 }, { id: 'b', x: -1.0, z: 1.0, rotY: 0 }], [], (r) => { swaps.push(r); });
  for (let i = 0; i < 240 && !swaps.length; i++) { applier.update(1 / 60); physics.step(1 / 60); }
  assert.deepEqual(swaps[0].arrived.sort(), ['a', 'b']);
  near(a.position.x, 1.0, 'a swapped', 0.02); near(b.position.x, -1.0, 'b swapped', 0.02);
});

test('6 + 7: a target inside a wall stops at the wall and is logged as stuck after 4 s; a held object is excluded', async () => {
  const built = buildRoomFromScan(sampleRoom);
  const physics = await createPhysics(new THREE.Scene());
  physics.setRoom(built);
  const box = new THREE.Group(), held = new THREE.Group();
  const s = new THREE.Vector3(0.4, 0.4, 0.4);
  physics.addObject('box', box, s, new Float32Array(), { x: 0, z: 1.2 }, 0, 0);
  physics.addObject('held', held, s, new Float32Array(), { x: -1.0, z: 1.2 }, 0, 0);
  for (let i = 0; i < 30; i++) physics.step(1 / 60);
  const applier = new ProposalApplier(physics);
  const results: { arrived: string[]; stuck: string[] }[] = [];
  applier.start([{ id: 'box', x: 3.0, z: 1.2, rotY: 0 }, { id: 'held', x: 0.5, z: 0, rotY: 0 }], ['held'], (r) => { results.push(r); });
  for (let i = 0; i < 60 * 5 && !results.length; i++) { applier.update(1 / 60); physics.step(1 / 60); }
  assert.deepEqual(results[0].stuck, ['box']);
  near(box.position.x + s.x / 2, 2.05, 'stopped at the east wall face', 0.02);
  near(held.position.x, -1.0, 'the held object never moved', 0.02);
});

test('8: Designer tiles and action tiles are hit where drawn; label lines are not', () => {
  const palette = new Palette();
  const items: PaletteItem[] = [
    { url: '', name: 'Reading corner', action: 'preset:reading_corner' },
    { url: '', name: 'Solving…', label: true },
    { url: '', name: 'Accept', action: 'accept', accent: true },
  ];
  palette.setItems(items);
  palette.group.updateMatrixWorld(true);
  const tiles = palette.group.children.filter((c) => c.userData.item);
  const rayInto = (tile: THREE.Object3D) => {
    const center = tile.getWorldPosition(new THREE.Vector3());
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(tile.matrixWorld);
    return new THREE.Raycaster(center.clone().addScaledVector(normal, 0.5), normal.clone().negate());
  };
  assert.equal(palette.hitTest(rayInto(tiles[0])), items[0]);
  assert.equal(palette.hitTest(rayInto(tiles[1])), null, 'the status line is not a target');
  assert.equal(palette.hitTest(rayInto(tiles[2])), items[2]);
});
