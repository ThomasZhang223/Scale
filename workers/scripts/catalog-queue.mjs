import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const mode = args.shift() ?? "verify";
const flag = name => args.includes(name);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const base = (option("--base", process.env.WORKER_BASE_URL ?? "https://full-scale-workers.thomaszhangdev.workers.dev")).replace(/\/$/, "");
if (new URL(base).protocol !== "https:") throw Error("--base must be HTTPS");
const receiptPath = path.resolve(option("--receipt", path.join(root, ".wrangler/catalog-jobs.json")));
async function request(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw Error(`${response.status} from ${new URL(url).pathname}: ${(await response.text()).slice(0, 500)}`);
  return response;
}
async function health() {
  const h = await (await request(`${base}/v1/health`)).json();
  if (h.d1 !== "ok" || h.meshPipeline?.revision !== "sequential-v1") throw Error("The new queue Worker is not deployed here, or D1 is unhealthy.");
  console.log(JSON.stringify({ base, meshPipeline: h.meshPipeline, secrets: h.secrets }, null, 2));
  return h;
}
async function token() {
  if (process.env.UPSTREAM_TOKEN) return process.env.UPSTREAM_TOKEN;
  try {
    const text = await readFile(path.join(root, "../infra/.env"), "utf8");
    const found = text.match(/^UPSTREAM_TOKEN=(.*)$/m)?.[1].trim();
    if (found) return found.replace(/^(['"])(.*)\1$/, "$2");
  } catch {}
  throw Error("Set UPSTREAM_TOKEN in your environment or infra/.env; never pass it as a command-line argument.");
}
async function verifyAssets(job) {
  const object = await (await request(`${base}/v1/objects/${job.objectId}`)).json();
  if (object.state !== "ready" || !object.glbUrl) throw Error(`Job done but object ${job.objectId} has no ready mesh`);
  const bytes = new Uint8Array(await (await request(object.glbUrl)).arrayBuffer());
  const view = new DataView(bytes.buffer);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) throw Error("Stored asset is not a valid GLB");
  return { objectId: job.objectId, glbUrl: object.glbUrl, bytes: bytes.length, bboxMeters: object.bboxMeters };
}
async function status(jobs, wait) {
  const deadline = Date.now() + Number(option("--timeout-minutes", "30")) * 60_000;
  do {
    const states = [];
    for (const job of jobs) states.push({ ...job, ...await (await request(`${base}/v1/jobs/${job.jobId}`)).json() });
    const counts = {};
    for (const row of states) counts[row.state] = (counts[row.state] ?? 0) + 1;
    console.log(JSON.stringify({ at: new Date().toISOString(), counts }));
    const failed = states.filter(row => row.state === "failed");
    if (failed.length) { console.error(JSON.stringify(failed, null, 2)); process.exitCode = 1; }
    if (states.every(row => ["done", "failed"].includes(row.state))) {
      for (const row of states.filter(row => row.state === "done")) console.log(JSON.stringify(await verifyAssets(row)));
      return;
    }
    if (!wait) return;
    if (Date.now() >= deadline) throw Error("Wait timed out. Jobs remain durable; rerun mesh:status with the receipt.");
    await new Promise(resolve => setTimeout(resolve, 10_000));
  } while (true);
}
if (mode === "verify") {
  const h = await health();
  if (!h.meshPipeline.providerConfigured) { console.error("Queue is deployed; conversion is waiting for BASETEN_URL and BASETEN_API_KEY. See MESH_QUEUE.md for the adapter contract."); process.exitCode = 1; }
} else if (mode === "submit") {
  const h = await health();
  if (!h.meshPipeline.providerConfigured && !flag("--enqueue-only")) throw Error("Provider is unconfigured. Set the secrets or explicitly use --enqueue-only to park jobs.");
  const filename = option("--file", path.join(root, "../services/ingest/prebake/manifest.json"));
  const doc = JSON.parse(await readFile(filename, "utf8"));
  const all = Array.isArray(doc) ? doc : doc.products ?? doc.objects ?? doc.items;
  if (!Array.isArray(all)) throw Error("Expected an array, products, objects, or items");
  const limit = Number(option("--limit", "1"));
  if (!Number.isInteger(limit) || limit < 1) throw Error("--limit must be a positive integer");
  const rows = all.slice(0, limit);
  const jobs = [];
  const credential = await token();
  for (let i = 0; i < rows.length; i += 25) {
    const result = await (await request(`${base}/v1/catalog/ingest`, { method: "POST", headers: { "content-type": "application/json", "x-upstream-token": credential }, body: JSON.stringify({ products: rows.slice(i, i + 25) }) })).json();
    jobs.push(...result.jobs);
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify({ base, jobs }, null, 2) + "\n");
  }
  console.log(`Accepted ${jobs.length} items. Receipt: ${receiptPath}`);
  if (flag("--wait")) await status(jobs, true);
} else if (mode === "status") {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (receipt.base !== base) throw Error("Receipt belongs to another Worker; pass its --base explicitly.");
  await status(receipt.jobs, flag("--wait"));
} else throw Error("Use verify, submit, or status");
