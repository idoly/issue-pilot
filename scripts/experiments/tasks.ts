import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ExperimentTask { id: string; prompt: string; expected: unknown }

export async function createEvidence(root: string): Promise<ExperimentTask[]> {
  await mkdir(root, { recursive: true });
  const orders = Array.from({ length: 1200 }, (_, i) => ({ id: i + 1, service: i % 3 === 0 ? "oms" : "srm", cents: (i % 29 + 1) * 100, status: i % 7 === 0 ? "failed" : "paid", trace: `trace-${i % 40}` }));
  const logs = orders.filter(row => row.status === "failed").map(row => ({ orderId: row.id, trace: row.trace, service: "gateway", error: row.id % 2 === 0 ? "timeout" : "invalid_state" }));
  const refunds = orders.filter(row => row.id % 11 === 0).map(row => ({ orderId: row.id, cents: Math.floor(row.cents / 2) }));
  const files: Record<string, string> = {
    "config.json": JSON.stringify({ service: "oms", retry: { attempts: 4, backoffMs: 250 } }),
    "orders.json": JSON.stringify(orders), "logs.json": JSON.stringify(logs), "refunds.json": JSON.stringify(refunds),
    "prices.csv": "sku,quantity,cents\nA,2,125\nB,3,210\nC,4,99\n",
    "discount.cjs": "exports.total = (cents, percent) => cents - percent;\n",
    "README.md": "Synthetic offline fixture. All services are in the same environment. No real customer or credential data.\n",
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content, { mode: 0o400 });
  const paid = orders.filter(row => row.status === "paid");
  const oms = paid.filter(row => row.service === "oms");
  const traceCounts: Record<string, number> = {};
  for (const log of logs) traceCounts[log.trace] = (traceCounts[log.trace] ?? 0) + 1;
  const top = Object.entries(traceCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
  const task = (id: string, prompt: string, expected: unknown) => ({ id, prompt: `${prompt}\nEvidence files are under /evidence. Return only the requested JSON object as your final answer.`, expected });
  return [
    task("simple-config", "Read config.json. Return {\"attempts\":number,\"backoffMs\":number}.", { attempts: 4, backoffMs: 250 }),
    task("csv-total", "From prices.csv, sum quantity*cents. Return {\"totalCents\":number}.", { totalCents: 1276 }),
    task("large-aggregate", "From orders.json, count paid orders and sum their cents. Return {\"count\":number,\"totalCents\":number}.", { count: paid.length, totalCents: paid.reduce((sum, row) => sum + row.cents, 0) }),
    task("cross-service-filter", "From orders.json, count paid OMS orders and sum their cents. Return {\"count\":number,\"totalCents\":number}.", { count: oms.length, totalCents: oms.reduce((sum, row) => sum + row.cents, 0) }),
    task("cross-service-join", "Join failed OMS orders in orders.json with gateway logs in logs.json by orderId=id. Count those with error timeout. Return {\"count\":number}.", { count: logs.filter(log => log.error === "timeout" && orders[log.orderId - 1]!.service === "oms").length }),
    task("refund-join", "Sum refunds.json cents only for orders whose status is paid in orders.json. Return {\"refundCents\":number}.", { refundCents: refunds.filter(refund => orders[refund.orderId - 1]!.status === "paid").reduce((sum, row) => sum + row.cents, 0) }),
    task("trace-ranking", "Count logs.json entries by trace. Return the most frequent trace; ties sort trace ascending lexicographically. Return {\"trace\":string,\"count\":number}.", { trace: top[0], count: top[1] }),
    task("reproduction", "discount.cjs should reduce cents by percent%. For input (10000,20), report current and corrected result. You may copy and fix the module under /work and run checks. Return {\"actual\":number,\"corrected\":number}.", { actual: 9980, corrected: 8000 }),
  ];
}
