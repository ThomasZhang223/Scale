import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
function run(args, executable = process.execPath) {
  const result = spawnSync(executable, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run([wrangler, "types"]);
run([fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "--noEmit"]);
run(["--experimental-transform-types", "--test", "tests/mesh-queue.test.mjs", "tests/embedding.test.mjs",
     "tests/find.test.mjs", "tests/find-ready.test.mjs", "tests/listings-generate.test.mjs",
     "tests/scan-thumb.test.mjs"]);
run([wrangler, "deploy", "--dry-run"]);
if (process.argv.includes("--check")) process.exit(0);
run([wrangler, "whoami"]);
// These are additive CREATE IF NOT EXISTS migrations; existing catalogue/room data stays.
run([wrangler, "d1", "execute", "full-scale-db", "--remote", "--file", "src/schema.sql", "--yes"]);
run([wrangler, "d1", "execute", "full-scale-db", "--remote", "--file", "src/mesh-schema.sql", "--yes"]);
run([wrangler, "d1", "execute", "full-scale-db", "--remote", "--file", "src/thumb-schema.sql", "--yes"]);
run([wrangler, "deploy"]);
run([wrangler, "deployments", "list"]);
run([wrangler, "queues", "info", "full-scale-jobs"]);
console.log("Deployed. Run npm run mesh:verify, then submit ONE item before the full batch. See MESH_QUEUE.md.");
