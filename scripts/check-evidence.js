/**
 * Fails CI when the capture no longer proves the contract.
 *
 * The evidence file is produced by `examples/wire_capture.js`; this script only
 * asserts the invariants a gateway would rely on.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = JSON.parse(
  readFileSync(join(root, "e2e", "evidence", "openclaw.json"), "utf8"),
);

const failures = [];

for (const [name, value] of Object.entries(evidence.checks)) {
  if (typeof value === "boolean" && value !== true) {
    failures.push(`${name} is ${value}`);
  }
}

const expectedStates = ["start", "append", "compact", "append", "pause", "resume", "stop"];
if (evidence.checks.states.join(",") !== expectedStates.join(",")) {
  failures.push(`state sequence is ${evidence.checks.states.join(",")}`);
}

if (evidence.checks.epochs.join(",") !== "0,0,0,1,1,1,1") {
  failures.push(`epoch sequence is ${evidence.checks.epochs.join(",")}`);
}

const auxiliary = evidence.requests.find((request) => request.stage === "auxiliary:compaction");
if (!auxiliary || auxiliary.hint_header_present !== false) {
  failures.push("the auxiliary request carried a hint");
}

if (failures.length > 0) {
  console.error("evidence checks failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(`evidence ok: ${evidence.requests.length} requests, ${evidence.checks.states.length} hints`);
