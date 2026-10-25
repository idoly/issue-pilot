import { errorMessage } from "../data/client";

export function settingsError(error: unknown): string {
  const code = errorMessage(error);
  const messages: Record<string, string> = {
    configuration_changed: "配置已被更新，请重新加载后再保存。当前输入已保留。",
    conflict: "该邮箱或仓库地址已存在。",
    repository_is_used_by_services: "仓库仍被服务使用，请先解除关联。",
    issue_already_running: "相关工单正在运行，请稍后重试。",
    service_has_running_issues: "相关环境有运行中的工单，请稍后重试。",
    last_active_admin: "至少保留一位在用的开发管理人员。",
    last_active_developer: "至少保留一位在用的开发人员。",
    last_active_user: "至少保留一位在用人员。",
    developer_role_required: "此操作需要开发角色。",
    admin_role_required: "此操作需要管理权限。",
    resource_in_use: "配置仍被使用，不能删除。",
  };
  return messages[code] ?? code;
}
