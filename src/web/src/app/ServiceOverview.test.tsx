import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { ServiceOverview } from "./ServiceOverview";
import type { Service } from "../data/client";

describe("service description", () => {
  it("shows repository branches in one compact matrix and omits redundant hints and environment counts", () => {
    const service: Service = {
      revision: 0, key: "orders", name: "Orders", description: "**Order service**", context: "**Order service**\n\n### 正式环境\n\n- SLS：orders-prod / application\n\n### 开发环境\n\n查询能力继承正式和测试环境。",
      repositories: [{ id: "binding", alias: "order-api", url: "git@example.test:orders.git" }],
      deployments: [
        { environmentKey: "test", repositoryBranches: [{ repositoryId: "binding", repositoryAlias: "order-api", baseBranch: "release/test" }], capabilities: [] },
        { environmentKey: "prod", repositoryBranches: [{ repositoryId: "binding", repositoryAlias: "order-api", baseBranch: "release/prod" }], capabilities: [] },
        { environmentKey: "dev", repositoryBranches: [{ repositoryId: "binding", repositoryAlias: "order-api", baseBranch: "develop" }], capabilities: [] },
      ],
    };
    const view = render(() => <ServiceOverview service={service} repositories={[{ id: "catalog", revision: 0, name: "订单服务仓库", url: "git@example.test:orders.git", createdAt: "", updatedAt: "", services: [] }]} environments={[{ key: "prod", name: "正式" }, { key: "test", name: "测试" }, { key: "dev", name: "开发" }]} />);
    expect(screen.getByRole("heading", { name: "代码分支" })).toBeTruthy();
    expect(screen.getByLabelText("仓库与环境分支")).toBeTruthy();
    expect(screen.getByText("订单服务仓库")).toBeTruthy();
    expect([...view.container.querySelectorAll(".repository-column-heading")].map(node => node.textContent)).toEqual(["仓库", "开发", "测试", "正式"]);
    expect([...view.container.querySelectorAll(".service-repository-branch")].map(node => node.textContent)).toEqual(["develop", "release/test", "release/prod"]);
    expect(view.container.querySelector(".service-repository-name")?.getAttribute("title")).toBe("git@example.test:orders.git");
    for (const redundant of ["个关联仓库", "仓库名称和地址由仓库配置统一维护", "部署引用", "个环境", "代码基准分支"]) expect(view.container.textContent).not.toContain(redundant);
    expect(view.container.querySelector(".service-environment-card")).toBeNull();
    expect(view.container.querySelector(".service-description strong")?.textContent).toBe("Order service");
    view.unmount();
  });
});
