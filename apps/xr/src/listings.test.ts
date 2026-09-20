import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { needFromText, needFromDetected, rank, findListings, isShoppingRequest, classifyUtterance, clearScanWinner, commandOf, normalizeTranscript, SHOP_VERBS, SHOP_LEAD_INS, parseLengthMetres, productQuery, findLive, STOREFRONTS, type Listing } from './listings.ts';

const catalog: Listing[] = JSON.parse(readFileSync(new URL('../public/catalog.json', import.meta.url), 'utf-8'));

test('the bundled catalogue is Object v1 rows in metres with merchant facts', () => {
  assert.ok(catalog.length >= 50);
  for (const l of catalog) {
    assert.equal(l.schemaVersion, 1);
    assert.equal(l.source, 'catalog');
    assert.ok(l.bboxMeters.w > 0 && l.bboxMeters.w < 5, `${l.name}: width ${l.bboxMeters.w} is not metres`);
    assert.ok(l.imageUrl && l.productUrl && l.merchant);
  }
});

test('lengths convert to metres at the edge', () => {
  assert.equal(parseLengthMetres(80, 'cm'), 0.8);
  assert.equal(parseLengthMetres(1.5, 'm'), 1.5);
  assert.ok(Math.abs(parseLengthMetres(24, 'inches') - 0.6096) < 1e-9);
});

test('a sentence becomes a need: kind plus bounds, width by default', () => {
  const n = needFromText('find a lamp under 1.5 m tall for the 80 cm gap beside my desk');
  assert.equal(n.bucket, 'lighting');
  assert.ok(n.categoryWords!.includes('lamp'));
  assert.equal(n.maxH, 1.5);
  assert.equal(n.maxW, 0.8);
  assert.equal(needFromText('a sofa no deeper than 90 cm').maxD, 0.9);
  assert.equal(needFromText('a sofa no deeper than 90 cm').maxW, undefined);
});

test('a scanned chair asks for seating no more than 15% wider or deeper', () => {
  const n = needFromDetected({ identifier: 'c1', category: 'chair', dimensions: [0.6, 0.9, 0.6] });
  assert.equal(n.bucket, 'seating');
  assert.ok(Math.abs(n.maxW! - 0.69) < 1e-9);
  assert.ok(Math.abs(n.maxD! - 0.69) < 1e-9);
  assert.equal(n.replaces?.identifier, 'c1');
});

test('ranking: the right kind that fills the gap wins; the wrong kind and the too-big are out', () => {
  const mk = (name: string, category: string, bucket: string, w: number, d: number): Listing => ({
    schemaVersion: 1, objectId: name, source: 'catalog', state: 'measured', name, category, bucket,
    glbUrl: null, bboxMeters: { w, h: 0.8, d }, measure: { method: 'extracted', confidence: 0.9 },
  });
  const rows = [
    mk('wide sofa', 'sofas', 'seating', 2.2, 0.9),
    mk('small stool', 'stool', 'seating', 0.4, 0.4),
    mk('snug chair', 'lounge chair', 'seating', 0.78, 0.7),
    mk('side table', 'side tables', 'surface', 0.5, 0.5),
    mk('Chair-side lamp', 'table lamp', 'lighting', 0.3, 0.3), // "chair" in the title is not a chair
  ];
  const recs = rank(rows, needFromText('a chair for the 80 cm gap'));
  assert.deepEqual(recs.map((r) => r.listing.name), ['snug chair', 'small stool']);
  assert.match(recs[0].reasons.join(' '), /78 cm wide, 2 cm to spare/);
  assert.ok(recs.every((r) => r.score > 0 && r.score <= 1));
});

test('the bundled scrape yields real recommendations for a scanned sofa', () => {
  const recs = rank(catalog, needFromDetected({ identifier: 's', category: 'sofa', dimensions: [2.4, 0.9, 1.0] }));
  assert.ok(recs.length > 0);
  assert.ok(recs.every((r) => r.listing.bboxMeters.w <= 2.4 * 1.15));
  assert.ok(recs.every((r) => /sofa|sectional|seating/.test(`${r.listing.category} ${r.listing.bucket}`)));
});

test('findListings prefers live rows and says when it fell back to the bundle', async () => {
  const need = needFromText('a lamp');
  const live = catalog.filter((l) => l.bucket === 'lighting').slice(0, 3);
  const a = await findListings(need, 8, { live: async () => live, bundled: async () => catalog });
  assert.equal(a.source, 'live');
  assert.equal(a.note, null);
  const b = await findListings(need, 8, { live: async () => [], bundled: async () => catalog });
  assert.equal(b.source, 'bundled');
  assert.match(b.note!, /nothing indexed/);
  const c = await findListings(need, 8, { live: async () => { throw new Error('503'); }, bundled: async () => catalog });
  assert.equal(c.source, 'bundled');
  assert.match(c.note!, /failed \(503\)/);
  assert.ok(c.recommendations.length > 0);
});

test('shopping sentences route to listings; rearranging ones do not', () => {
  assert.ok(isShoppingRequest('find something that fits beside my desk'));
  assert.ok(isShoppingRequest('recommend a lamp'));
  assert.ok(!isShoppingRequest('make it cozy'));
  assert.ok(!isShoppingRequest('move the sofa to the window'));
});

test('productQuery strips the imperative and the length phrases, keeping the product words', () => {
  assert.equal(productQuery('find me a lamp under 1.5 m tall'), 'lamp');
  assert.equal(productQuery('Find a red chair for the 80 cm gap beside my desk'), 'red chair beside my desk');
  assert.equal(productQuery('recommend some floor lamps'), 'floor lamps');
  assert.equal(productQuery('lamp'), 'lamp');
  assert.equal(productQuery('show me something 1 m wide'), 'something');
  assert.equal(productQuery('find another lamp'), 'another lamp');
});

/*
 * The routing table. Every line is a sentence a person actually says to a headset, in the shape
 * ElevenLabs STT returns it: sentence case, no trailing period on a statement, a question mark
 * on a question, "80-centimeter" for a spoken length, and a leading filler.
 *
 * The three marked LIVE are verbatim from a real TTS -> STT round trip against the deployed
 * proxy on 2026-09-20; the rest are written in the same shape.
 */
const ROUTING: [string, 'command' | 'mine' | 'shop' | 'library' | 'design'][] = [
  // (a) the user's own scans — "my" beats every shopping verb
  ['Show me the chair I scanned with my phone', 'mine'],                    // LIVE
  ['Show me my scans', 'mine'],
  ['What have I scanned?', 'mine'],
  ['Find my chair', 'mine'],
  ['Where is my chair?', 'mine'],
  ['Bring in the thing I just scanned', 'mine'],
  ['Put my latest scan in the room', 'mine'],
  ['Can you show me the stuff I captured on my phone?', 'mine'],
  ['What did I scan earlier?', 'mine'],
  ['Add my last scan', 'mine'],
  // (b) a product request. A named store means the merchants; without one the built-in
  // library answers first and falls through to the merchants when it has no match.
  ['Find me a couch on shopify', 'shop'],
  ['Show me what the store has', 'shop'],
  ['Add a couch', 'library'],
  ['Bring in a chair', 'library'],
  ['Give me a sofa from our furniture', 'library'],
  ['Hey, can you show me some lamps that fit the 80-centimeter gap beside my desk?', 'library'], // LIVE
  ['Find me a lamp', 'library'],
  ['Can you show me some chairs?', 'library'],
  ['I need a new side table', 'library'],
  ['Get me a coffee table under 1 meter', 'library'],
  ['Look for a floor lamp', 'library'],
  ['Do you have any lamps?', 'library'],
  ['Ok so, find something that fits the 80-centimeter gap beside my desk', 'library'],
  ['Show me what is for sale', 'shop'],
  ['Um, I want a dresser', 'library'],
  ['Search for a walnut sideboard', 'library'],
  ['Browse nightstands', 'library'],
  // (c) everything else — the layout agent, exactly as before
  ['Move the sofa to the window', 'design'],                                // LIVE
  ['Make it cozy', 'design'],
  ['Turn it 90 degrees', 'design'],
  ['I need the sofa moved to the window', 'design'],
  ['Rearrange the room', 'command'],
  ['Clear everything', 'design'],
  ['Put the lamp in the corner', 'design'],
  ['Undo that', 'command'],
];

/*
 * Spoken button presses. Each fires the tile's own action, so the table is about WHICH tile, not
 * about what the tile does. The near-misses below matter more than the hits: a command must
 * match the whole utterance, or "keep the sofa by the window" stops being a sentence.
 */
const COMMAND_TABLE: [string, ReturnType<typeof commandOf>][] = [
  ['Keep it.', 'keep'],
  ['Keep this', 'keep'],
  ['Ok, looks good.', 'keep'],
  ['That works', 'keep'],
  ['Accept it', 'keep'],
  ['Put it back', 'putback'],
  ['Put that back.', 'putback'],
  ['Undo that!', 'putback'],
  ['Undo', 'putback'],
  ['Revert that', 'putback'],
  ['Never mind', 'putback'],
  ['Try again', 'ask_again'],
  ['Ask again.', 'ask_again'],
  ['Another option', 'ask_again'],
  ['Something else', 'ask_again'],
  ['Rearrange.', 'rearrange'],
  ['Rearrange the room', 'rearrange'],
  ['Show the listings', 'listings'],
  ['Open listings', 'listings'],
  ['Open designer', 'page:Designer'],
  ['Go to the room', 'page:Room'],
  ['Open my scans', 'page:My scans'],
  ['Open the catalogue', 'page:Furniture'],
  ['Switch to furniture', 'page:Furniture'],
  // Near-misses: a sentence, not a button press. Every one of these must stay null.
  ['keep the sofa by the window', null],
  ['put the lamp back by the desk', null],
  ['open up the room a bit', null],
  ['try again with a smaller table', null],
  ['undo the mess in the corner', null],
  ['show me the listings for a lamp', null],
  ['rearrange the room so it feels open', null],
  ['I like it here by the window', null],
];

test('a command phrase is a button press; a sentence containing the same words is not', () => {
  const wrong = COMMAND_TABLE.filter(([text, want]) => commandOf(text) !== want)
    .map(([text, want]) => `${JSON.stringify(text)} wanted ${want}, got ${commandOf(text)}`);
  assert.deepEqual(wrong, []);
  assert.ok(COMMAND_TABLE.filter(([, c]) => c !== null).length >= 15, 'at least 15 command phrasings');
});

test('a near-miss command falls through to the handler it would have reached anyway', () => {
  // The danger of checking commands first is shadowing. These must be unchanged by it.
  assert.equal(classifyUtterance('keep the sofa by the window').kind, 'design');
  assert.equal(classifyUtterance('put the lamp back by the desk').kind, 'design');
  assert.equal(classifyUtterance('show me the listings for a lamp').kind, 'shop');  // "listings" names a store
  assert.equal(classifyUtterance('open my scans folder on the phone').kind, 'mine');
});

test('nothing destructive is reachable by voice', () => {
  // Reset room and Clear stay tablet-only: a misheard word must not empty the room on stage.
  for (const [, command] of COMMAND_TABLE) {
    assert.ok(command === null || !/^(reset|clear)$/.test(command), String(command));
  }
  for (const t of ['clear everything', 'reset the room', 'clear the room', 'start over'])
    assert.equal(commandOf(t), null, t);
});

test('every routing-table sentence reaches the handler it belongs to', () => {
  const wrong = ROUTING.filter(([text, want]) => classifyUtterance(text).kind !== want)
    .map(([text, want]) => `${JSON.stringify(text)} wanted ${want}, got ${classifyUtterance(text).kind}`);
  assert.deepEqual(wrong, []);
  assert.ok(ROUTING.length >= 25, `only ${ROUTING.length} transcripts`);
});

test('"my" that says WHERE a thing goes is not a claim to own it', () => {
  // The positioning sentence in CLAUDE.md. It must reach the merchants, not the scan library.
  assert.equal(classifyUtterance('find something that fits the 80 cm gap beside my desk').kind, 'library');
  assert.equal(classifyUtterance('what fits next to my sofa?').kind, 'library');
  assert.equal(classifyUtterance('put a lamp beside my desk').kind, 'design');
  // ...but the same possessive naming the thing itself does.
  assert.equal(classifyUtterance('put my lamp beside the desk').kind, 'mine');
});

test('the newest and list-only flags come off the words that mean them', () => {
  for (const t of ['my latest scan', 'the thing I just scanned', 'add my last scan', 'my newest capture'])
    assert.equal(classifyUtterance(t).newest, true, t);
  for (const t of ['show me my scans', 'what have I scanned?', 'list my scans'])
    assert.equal(classifyUtterance(t).listOnly, true, t);
  assert.equal(classifyUtterance('find my chair').newest, false);
  assert.equal(classifyUtterance('find my chair').listOnly, false);
});

test('routing and productQuery read ONE list, so routing can never be the narrower of the two', () => {
  // The root cause of "voice only rearranges": the router tested a shorter set than the parser
  // behind it could handle. Every opener must BOTH route to shopping and be stripped — an
  // opener that only does one of the two is the defect this test exists to catch.
  for (const head of [...SHOP_VERBS, ...SHOP_LEAD_INS]) {
    const sentence = `${head} a walnut side table`;
    // A product request either way: the library answers first unless a store is named, and a
    // head that is itself a commerce word ("buy", "order") names one on its own.
    assert.ok(['shop', 'library'].includes(classifyUtterance(sentence).kind), sentence);
    assert.equal(classifyUtterance(`${sentence} on shopify`).kind, 'shop', sentence);
    assert.equal(productQuery(sentence), 'walnut side table', sentence);
  }
});

test('a declarative lead-in is stripped like an imperative, and "new" is an article', () => {
  assert.equal(productQuery('I need a new side table'), 'side table');
  assert.equal(productQuery('Do you have any lamps?'), 'lamps');
  assert.equal(productQuery('Is there a walnut sideboard?'), 'walnut sideboard');
  assert.equal(productQuery("I'm looking for a floor lamp"), 'floor lamp');
  assert.equal(productQuery('How about a dresser?'), 'dresser');
});

test('the fit clause is not sent to the storefront: the bounds already carry it', () => {
  // One live Browserbase render per store, so the query it gets has to be the product words.
  const spoken = 'Hey, can you show me some lamps that fit the 80-centimeter gap beside my desk?';
  assert.equal(productQuery(spoken), 'lamps');
  assert.equal(needFromText(spoken).maxW, 0.8, 'the bound must survive where the words did not');
  // The bare article stays: productQuery strips an OPENER, and "a bookcase…" has none.
  assert.equal(productQuery('a bookcase that will fit the alcove'), 'a bookcase');
  assert.equal(productQuery('a sideboard which fits under the window'), 'a sideboard');
  // "fits" inside the product words, with no relative pronoun, is left alone.
  assert.equal(productQuery('find a lamp'), 'lamp');
});

test('isShoppingRequest is the shop branch of the same function', () => {
  assert.ok(isShoppingRequest('find something that fits beside my desk'));
  assert.ok(isShoppingRequest('recommend a lamp'));
  assert.ok(!isShoppingRequest('make it cozy'));
  assert.ok(!isShoppingRequest('move the sofa to the window'));
  assert.ok(!isShoppingRequest('show me my scans'), 'my stuff is not shopping');
});

test('a spoken length reaches the metric filter, hyphen and US spelling and all', () => {
  // ElevenLabs writes "eighty centimetres" as "80-centimeter"; \s* between number and unit
  // dropped the bound silently on every voice request.
  assert.equal(needFromText('a lamp that fits the 80-centimeter gap').maxW, 0.8);
  assert.equal(needFromText('a lamp that fits the 80 centimetres gap').maxW, 0.8);
  assert.equal(needFromText('a lamp that fits the 80cm gap').maxW, 0.8);
  assert.equal(needFromText('a shelf no taller than 1.5-m').maxH, 1.5);
  assert.equal(needFromText('a desk 60-cm deep').maxD, 0.6);
});

test('a leading filler no longer sends the whole sentence to the merchant search', () => {
  assert.equal(productQuery('Hey, can you find me a floor lamp?'), 'floor lamp');
  assert.equal(productQuery('Ok so, get me a side table'), 'side table');
  assert.equal(productQuery('Um, show me some chairs'), 'chairs');
  // The anchor stays: a verb in the middle of a sentence is not an imperative.
  assert.equal(productQuery('the lamp I want to get'), 'the lamp I want to get');
});

test('findLive posts one /find per storefront in parallel, reports stages, and merges listings', async () => {
  const bodies: Record<string, unknown>[] = [];
  const stages: string[] = [];
  const row = (merchant: string, i: number) => ({
    schemaVersion: 1, objectId: `${merchant}-${i}`, source: 'catalog', state: 'measured', name: `Lamp ${i}`, category: 'lighting',
    glbUrl: null, bboxMeters: { w: 0.3, h: 1.2, d: 0.3 }, merchant, productUrl: null, price: null,
    measure: { method: 'extracted', confidence: 0.9 }, extraction: { imageUrl: `https://cdn/${i}.jpg`, fits: true, via: 'api', productId: String(i) },
  });
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    if (body.merchant === 'Sabai Design') return new Response(JSON.stringify({ error: 'upstream_error', message: 'ingest answered 502' }), { status: 502 });
    return new Response(JSON.stringify({ merchant: body.merchant, storefront: body.storefront, searchUrl: 'u', searchedFor: 'lamp', handles: 2, products: 2, measured: 2, fitting: 2, fallbackSuspected: false, warning: null, listings: [row(body.merchant, 1), row(body.merchant, 2)] }));
  }) as unknown as typeof fetch;

  const rows = await findLive({ text: 'find me a lamp under 1.5 m', bucket: 'lighting', categoryWords: ['lamp'], maxH: 1.5 }, 8, (s) => stages.push(`${s.merchant}:${s.stage}`), fetchFn);
  assert.equal(bodies.length, STOREFRONTS.length);
  assert.equal(bodies[0].query, 'lamp');
  assert.deepEqual(bodies[0].fit, { maxH: 1.5 });
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.imageUrl?.startsWith('https://cdn/')));
  for (const { merchant } of STOREFRONTS) assert.ok(stages.includes(`${merchant}:searching`), `${merchant} never started`);
  assert.ok(stages.includes('Poly & Bark:done'));
  assert.ok(stages.includes('Sabai Design:failed'));
});

test('rank keeps the Worker order for equally scored rows, so the least distorted mesh stays first', () => {
  // The Worker returns least-distorted first (X-Find-Source). These three score identically:
  // same kind, same box, same confidence. Only the incoming order can separate them.
  const lamp = (name: string) => ({
    schemaVersion: 1, objectId: name, source: 'catalog', state: 'ready', name, category: 'lighting',
    glbUrl: `https://api/${name}.glb`, bboxMeters: { w: 0.3, h: 1.2, d: 0.3 },
    measure: { method: 'extracted', confidence: 0.9 }, merchant: 'Poly & Bark', productUrl: null, price: null,
  }) as unknown as Listing;
  const order = ['Zeta Lamp', 'Alpha Lamp', 'Mid Lamp'];
  const out = rank(order.map(lamp), { categoryWords: ['light'] }, 8); // matches the category, not the title
  assert.deepEqual(out.map((r) => r.listing.name), order);
  assert.equal(new Set(out.map((r) => r.score)).size, 1, 'the three must tie, or this proves nothing');
});

test('findLive returns one row per objectId when every store was topped up from the same catalogue', async () => {
  const stages: string[] = [];
  const shared = (i: number) => ({
    schemaVersion: 1, objectId: `catalog-${i}`, source: 'catalog', state: 'ready', name: `Lamp ${i}`, category: 'lighting',
    glbUrl: `https://api/v1/assets/objects/catalog-${i}/mesh.glb`, bboxMeters: { w: 0.3, h: 1.2, d: 0.3 },
    merchant: 'Poly & Bark', productUrl: null, price: null, measure: { method: 'extracted', confidence: 0.9 },
    extraction: { imageUrl: null, fits: true, via: 'catalog-ready', productId: null }, findSource: 'catalog',
  });
  // Every store answers with the SAME two meshed catalogue rows, which is what the Worker does
  // in ready-only mode, plus one storefront row of its own.
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({
      merchant: body.merchant, storefront: body.storefront, searchUrl: 'u', searchedFor: 'lamp',
      handles: 0, products: 0, measured: 3, fitting: 3, fallbackSuspected: false,
      warning: 'storefront search failed: browserbase timeout',
      listings: [{ ...shared(1), objectId: `own-${body.merchant}` }, shared(1), shared(2)],
    }));
  }) as unknown as typeof fetch;

  const rows = await findLive({ text: 'find me a lamp', categoryWords: ['lamp'] }, 8, (s) => stages.push(s.detail), fetchFn);
  assert.equal(rows.length, STOREFRONTS.length + 2);
  assert.equal(new Set(rows.map((r) => r.objectId)).size, rows.length);
  // A dead storefront behind a full menu has to be visible, not hidden by the row count.
  assert.ok(stages.some((d) => d.startsWith('storefront search failed')), stages.join(' | '));
});

test('findLive throws when every store failed, so findListings can fall back and say so', async () => {
  const fetchFn = (async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' })) as unknown as typeof fetch;
  await assert.rejects(findLive({ text: 'lamp' }, 8, undefined, fetchFn), /every store failed/);
});

test('the one STT homophone is repaired, and nothing else is touched', () => {
  // Measured in the speech run: "Add a desk" comes back as "At a desk".
  assert.equal(normalizeTranscript('At a desk'), 'add a desk');
  assert.equal(normalizeTranscript('at an armchair'), 'add an armchair');
  assert.equal(classifyUtterance(normalizeTranscript('At a desk')).kind, 'library');
  // A real locative must survive untouched, whichever shape it takes.
  for (const t of ['at the window, put the sofa by it', 'At the desk, turn the chair', 'look at a lamp',
    'at an angle, turn it', 'at a glance it is fine', 'at a time when the room was empty']) {
    assert.equal(normalizeTranscript(t), t, t);
  }
  // Known and harmless: a bare "At an angle" becomes "add an angle", which finds nothing in the
  // library, falls through to the shops and finds nothing there either. Nothing is placed.
  assert.equal(normalizeTranscript('At an angle'), 'add an angle');
  assert.equal(classifyUtterance(normalizeTranscript('at the window, put the sofa by it')).kind, 'design');
});

test('a scan is placed unasked only when it clearly beats the next one', () => {
  const hit = (id: string, score: number) => ({ score, object: { objectId: id } as never });
  // Real numbers from the deployed index, 2026-09-20, after the scans got image vectors.
  assert.equal(clearScanWinner([hit('bag', 0.0912), hit('b', 0.0702)])?.objectId, 'bag');   // 1.30x
  assert.equal(clearScanWinner([hit('bust', 0.0928), hit('b', 0.0694)])?.objectId, 'bust'); // 1.34x
  // Two of the four scans ARE people, so this one must stay ambiguous rather than guess.
  assert.equal(clearScanWinner([hit('person', 0.1132), hit('bust', 0.1120)]), null);        // 1.01x
  assert.equal(clearScanWinner([hit('only', 0.01)])?.objectId, 'only');
  assert.equal(clearScanWinner([]), null);
});
