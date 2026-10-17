import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { utils, write } from "@e965/xlsx";
import { describe, expect, it } from "vitest";
import { ExcelPreview } from "./ExcelPreview";

describe("Excel preview", () => {
  it("switches sheets, paginates all rows and renders cell contents as text", async () => {
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(Array.from({ length: 101 }, (_, index) => [index === 0 ? '<script>alert(1)</script>' : `row ${index + 1}`, "00123"])), "人员");
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([["总计", 101]]), "汇总");
    const content = write(workbook, { type: "array", bookType: "xlsx" });
    const blob = { arrayBuffer: async () => content } as Blob;
    const view = render(() => <ExcelPreview blob={blob} fileName="test.xlsx" />);
    expect(await screen.findByText('<script>alert(1)</script>')).toBeTruthy();
    expect(view.container.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("row 101")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Excel 工作表"), { target: { value: "1" } });
    await waitFor(() => expect(screen.getByText("总计")).toBeTruthy());
    expect(screen.queryByText("row 101")).toBeNull();
    view.unmount();
  });
});
