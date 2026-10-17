import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { ExcelSheet } from "../../../documents/excel";

export function ExcelPreview(props: { blob: Blob; fileName: string }) {
  const [sheets, setSheets] = createSignal<ExcelSheet[]>([], { ownedWrite: true });
  const [selected, setSelected] = createSignal(0, { ownedWrite: true });
  const [page, setPage] = createSignal(0, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  let generation = 0;
  createEffect(() => props.blob, (blob) => {
    const current = ++generation;
    setSheets([]); setSelected(0); setPage(0); setError(""); setLoading(true);
    void Promise.all([import("../../../documents/excel"), blob.arrayBuffer()]).then(([parser, buffer]) => {
      if (generation === current) setSheets(parser.parseExcel(new Uint8Array(buffer)));
    }).catch((cause) => { if (generation === current) setError(cause instanceof Error ? cause.message : "excel_parse_failed"); })
      .finally(() => { if (generation === current) setLoading(false); });
  });
  onCleanup(() => { generation += 1; });
  const rows = () => sheets()[selected()]?.rows ?? [];
  const columns = () => rows().reduce((count, row) => Math.max(count, row.length), 0);
  const visibleRows = () => rows().slice(page() * 100, (page() + 1) * 100);
  return <div class="excel-preview" aria-label={`预览 ${props.fileName}`}>
    <Show when={!loading()} fallback={<div class="empty-band">正在解析 Excel…</div>}>
      <Show when={!error()} fallback={<div class="workspace-error" role="alert">{error()}</div>}>
        <div class="excel-preview-toolbar"><label>工作表 <select aria-label="Excel 工作表" value={selected()} onChange={(event) => { setSelected(Number(event.currentTarget.value)); setPage(0); }}><For each={sheets()}>{(sheet, index) => <option value={index()}>{sheet.name}</option>}</For></select></label><span>{rows().length} 行 · {columns()} 列</span></div>
        <Show when={rows().length} fallback={<div class="empty-band">空工作表</div>}>
          <div class="excel-preview-scroll"><table><tbody><For each={visibleRows()}>{(row, index) => <tr><th scope="row">{page() * 100 + index() + 1}</th><For each={row}>{(cell) => <td>{cell}</td>}</For></tr>}</For></tbody></table></div>
          <div class="excel-preview-toolbar"><button type="button" disabled={page() === 0} onClick={() => setPage((value) => value - 1)}>上一页</button><span>{page() + 1} / {Math.max(1, Math.ceil(rows().length / 100))}</span><button type="button" disabled={(page() + 1) * 100 >= rows().length} onClick={() => setPage((value) => value + 1)}>下一页</button></div>
        </Show>
      </Show>
    </Show>
  </div>;
}
