import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, test } from "vitest";

import { App } from "./App";

describe("issue pilot workspace", () => {
  afterEach(() => document.body.replaceChildren());

  test("renders issues and data-backed statistics, then opens configuration", async () => {
    render(() => <App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());
    expect(screen.getByRole("region", { name: "ISSUE-0042 pi 终端" })).toBeTruthy();

    fireEvent.click(screen.getByText("ISSUE-0038").closest("button")!);
    const retryButton = await waitFor(() => screen.getByRole("button", { name: "重试处理" }));
    fireEvent.click(retryButton);
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试处理" })).toBeNull());

    fireEvent.click(screen.getByRole("radio", { name: "统计" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "工单处理统计" })).toBeTruthy());
    const submitted = await waitFor(() => screen.getByText("提出工单"));
    expect(submitted.parentElement?.textContent).toContain("3");
    expect(screen.getByText("已完成").parentElement?.textContent).toContain("0");
    expect(screen.getByRole("heading", { name: "个人处理情况" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "配置" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "配置" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "SRM" })).toBeTruthy();
    expect(screen.getByText("供应商关系管理服务。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "编辑服务" }));
    const serviceDialog = await waitFor(() => screen.getByRole("dialog", { name: "编辑服务" }));
    expect(screen.queryByLabelText("服务类型")).toBeNull();
    expect(serviceDialog.textContent).toContain("环境部署");
    const repositoryInput = screen.getByLabelText("仓库地址 1") as HTMLInputElement;
    repositoryInput.focus();
    fireEvent.input(repositoryInput, { target: { value: "git@example.test:team/updated.git" } });
    expect(document.activeElement).toBe(repositoryInput);
    expect(repositoryInput.value).toBe("git@example.test:team/updated.git");
    const branchInput = screen.getByLabelText("部署分支 1") as HTMLInputElement;
    branchInput.focus();
    fireEvent.input(branchInput, { target: { value: "release/test" } });
    expect(document.activeElement).toBe(branchInput);
    expect(branchInput.value).toBe("release/test");
    const configurationCapability = [...serviceDialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"][value="configuration_read"]')].find((input) => input.checked)!;
    const databaseCapability = [...serviceDialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"][value="database_read"]')].find((input) => input.checked)!;
    expect(configurationCapability.checked).toBe(true);
    expect(databaseCapability.checked).toBe(true);
    fireEvent.click(configurationCapability);
    expect(configurationCapability.checked).toBe(false);
    expect(databaseCapability.checked).toBe(true);

  });
});
