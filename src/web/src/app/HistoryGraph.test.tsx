import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryGraph, historyGraph } from "./HistoryGraph";

const commit = (hash: string, parents: string[]) => ({ hash, parents, shortHash: hash, author: "Fixture", subject: hash, date: "2026-10-17T00:00:00Z" });
afterEach(cleanup);

describe("Git history graph", () => {
  it("continues the commit lane through expanded files and ends it at the root", () => {
    const rows = historyGraph([commit("new", ["old"]), commit("old", [])]);
    expect(rows.get("new")!.output.map(lane => lane.id)).toEqual(["old"]);
    expect(rows.get("new")!.fileWidth).toBe(22);
    expect(rows.get("old")!.output).toEqual([]);
    expect(rows.get("old")!.fileWidth).toBe(11);
    const view = render(() => <HistoryGraph value={rows.get("new")!} expanded />);
    expect(view.container.querySelector("path")?.getAttribute("stroke-width")).toBe("3");
    expect(view.container.querySelector("circle")?.getAttribute("r")).toBe("5");
  });

  it("draws merge parents in separate lanes and rejoins them at the common ancestor", () => {
    const rows = historyGraph([commit("merge", ["left", "right"]), commit("left", ["base"]), commit("right", ["base"]), commit("base", [])]);
    const merge = rows.get("merge")!, right = rows.get("right")!, base = rows.get("base")!;
    expect(merge.output.map(lane => lane.id)).toEqual(["left", "right"]);
    expect(merge.width).toBe(33); expect(merge.fileWidth).toBe(33);
    expect(right.column).toBe(1);
    expect(base.input.map(lane => lane.id)).toEqual(["base", "base"]);
    expect(base.paths.some(path => path.d.includes("A 11 11"))).toBe(true);
    const view = render(() => <HistoryGraph value={merge} files />);
    const paths = view.container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[0]?.getAttribute("stroke-width")).toBe("3");
    expect(paths[1]?.getAttribute("stroke-width")).toBe("1");
    expect(paths[0]?.getAttribute("stroke")).not.toBe(paths[1]?.getAttribute("stroke"));
  });
});
