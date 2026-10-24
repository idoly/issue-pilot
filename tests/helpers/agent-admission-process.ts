import path from "node:path";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { AgentEngine } from "../../src/agent/engine.ts";

const [root, issueId] = process.argv.slice(2);
if (!root || !issueId || !process.send) throw new Error("admission_fixture_arguments_required");
process.on("message", () => {});
const database = await openApplicationDatabase(path.join(root, "issues.db"));
const engine = new AgentEngine(database.db, root);
// Hold execution after admission so the parent can kill the process before any model work.
(engine as unknown as { run(): Promise<void> }).run = async () => {
  await new Promise<void>(() => {});
};
await engine.send(issueId, "Keep this accepted input after a crash", undefined, [
  { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
]);
process.send({ type: "accepted" });
