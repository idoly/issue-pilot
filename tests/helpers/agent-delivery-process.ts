import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendQueuedAgentMessage, startAgentMessage } from "../../src/agent/message-delivery.ts";

const [file, serviceId, environmentId, phase] = process.argv.slice(2);
if (!file || !serviceId || !environmentId || !["queued", "started"].includes(phase ?? "") || !process.send) throw new Error("delivery_fixture_arguments_required");
process.on("message", () => {});
const manager = SessionManager.open(file);
const scope = { serviceId, environmentId };
const id = appendQueuedAgentMessage(manager, scope, "Crash-boundary input", [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
if (phase === "started") startAgentMessage(manager, id, scope);
process.send({ type: "checkpoint", phase });
