/* Adapted from VS Code scmHistory.ts. Copyright (c) Microsoft Corporation.
 * MIT License: permission is granted, free of charge, to use, copy, modify, merge,
 * publish, distribute, sublicense and/or sell this software, provided this notice
 * is included. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE
 * AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY ARISING FROM THE SOFTWARE OR ITS USE.
 * https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/scmHistory.ts
 */
import { For } from "solid-js";
import type { SourceCommit } from "../data/client";

type Lane = { id: string; color: string };
interface GraphRow {
  input: Lane[]; output: Lane[]; column: number; color: string; width: number; fileWidth: number;
  paths: { d: string; color: string }[];
  merge: boolean;
}
const referenceColor = "#59a4f9";
const branchColors = ["#ffb000", "#dc267f", "#994f00", "#40b0a6", "#b66dff"];

/** Keep lanes between rows, including through each commit's expanded file list. */
export function historyGraph(commits: SourceCommit[]): Map<string, GraphRow> {
  const rows = new Map<string, GraphRow>();
  let previous: Lane[] = [], colorIndex = -1;
  for (const [index, commit] of commits.entries()) {
    const input = previous, output: Lane[] = [];
    let firstParentAdded = false;
    if (commit.parents.length) for (const lane of input) {
      if (lane.id === commit.hash) {
        if (!firstParentAdded) { output.push({ id: commit.parents[0]!, color: index === 0 ? referenceColor : lane.color }); firstParentAdded = true; }
      } else output.push(lane);
    }
    for (let parent = firstParentAdded ? 1 : 0; parent < commit.parents.length; parent++) {
      const color = index === 0 && parent === 0 ? referenceColor : branchColors[++colorIndex % branchColors.length]!;
      output.push({ id: commit.parents[parent]!, color });
    }
    const inputIndex = input.findIndex(lane => lane.id === commit.hash), column = inputIndex < 0 ? input.length : inputIndex;
    const color = output[column]?.color ?? input[column]?.color ?? referenceColor;
    const paths: GraphRow["paths"] = [];
    let nextColumn = 0;
    for (const [laneIndex, lane] of input.entries()) {
      const x = 11 * (laneIndex + 1);
      if (lane.id === commit.hash) {
        if (laneIndex !== column) paths.push({ d: `M ${x} 0 A 11 11 0 0 1 ${11 * laneIndex} 11 H ${11 * (column + 1)}`, color: lane.color });
        else nextColumn++;
      } else if (output[nextColumn]?.id === lane.id) {
        const endX = 11 * (nextColumn + 1);
        paths.push({ d: laneIndex === nextColumn ? `M ${x} 0 V 22` : `M ${x} 0 V 6 A 5 5 0 0 1 ${x - 5} 11 H ${endX + 5} A 5 5 0 0 0 ${endX} 16 V 22`, color: lane.color });
        nextColumn++;
      }
    }
    for (const parent of commit.parents.slice(1)) {
      let parentColumn = output.length - 1;
      while (parentColumn >= 0 && output[parentColumn]!.id !== parent) parentColumn--;
      if (parentColumn < 0) continue;
      paths.push({ d: `M ${11 * parentColumn} 11 A 11 11 0 0 1 ${11 * (parentColumn + 1)} 22 M ${11 * parentColumn} 11 H ${11 * (column + 1)}`, color: output[parentColumn]!.color });
    }
    if (inputIndex >= 0) paths.push({ d: `M ${11 * (column + 1)} 0 V 11`, color: input[inputIndex]!.color });
    if (commit.parents.length) paths.push({ d: `M ${11 * (column + 1)} 11 V 22`, color });
    rows.set(commit.hash, { input, output, column, color, paths, merge: commit.parents.length > 1, width: 11 * (Math.max(input.length, output.length, 1) + 1), fileWidth: 11 * (output.length + 1) });
    previous = output;
  }
  return rows;
}

export function HistoryGraph(props: { value: GraphRow; expanded?: boolean; files?: boolean }) {
  const width = () => props.files ? props.value.fileWidth : props.value.width;
  return <svg class={props.files ? "source-history-file-graph" : "source-history-graph"} width={width()} height="22" style={{ width: `${width()}px`, "flex-basis": `${width()}px` }} aria-hidden="true">
    <For each={props.files ? props.value.output.map((lane, index) => ({ d: `M ${11 * (index + 1)} 0 V 22`, color: lane.color })) : props.value.paths}>{(path, index) => <path d={path.d} fill="none" stroke={path.color} stroke-width={props.files ? index() === props.value.column ? 3 : 1 : props.expanded && index() === props.value.paths.length - 1 ? 3 : 1} stroke-linecap="round" />}</For>
    <For each={props.files ? [] : props.value.merge ? [6, 3] : [5]}>{radius => <circle cx={11 * (props.value.column + 1)} cy="11" r={radius} fill={props.value.color} stroke-width="2" />}</For>
  </svg>;
}
