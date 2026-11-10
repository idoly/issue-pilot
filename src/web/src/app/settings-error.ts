import { errorMessage } from "../data/client";

export function settingsError(error: unknown): string {
  const code = errorMessage(error);
  const messages: Record<string, string> = {
    configuration_changed: "配置已被更新，请重新加载后再保存。当前输入已保留。",
    "invalid_application_parameter:dingtalkAttachmentHosts": "钉钉附件主机每行填一个主机名，不含协议、端口或路径，最多 100 个且不能重复。",
    "invalid_application_parameter:networkAllowedDomains": "Agent 网络基础白名单包含无效或重复的域名，最多填写 100 个。",
    invalid_issue_search_account_id: "请填写 32 位十六进制的 Cloudflare Account ID。",
    invalid_issue_search_token: "请填写有效的 Cloudflare API Token。",
    issue_search_account_token_required: "更换 Cloudflare 账号需要填写新 Token，或关闭搜索并清除旧 Token。",
    issue_search_credentials_required: "启用搜索需要填写 Cloudflare Account ID 和 API Token。",
    conflict: "该邮箱或仓库地址已存在。",
    invalid_user_email: "请填写有效的邮箱地址。",
    invalid_repository_url: "请填写有效的 HTTPS 或 SSH 仓库地址。",
    invalid_repository_group: "请填写 1 至 64 个字符的分组名称，不能包含控制字符。",
    repository_is_used_by_services: "仓库仍被服务使用，请先解除关联。",
    issue_already_running: "相关工单正在运行，请稍后重试。",
    service_has_running_issues: "相关环境有运行中的工单，请稍后重试。",
    last_active_admin: "至少保留一位在用的开发管理人员。",
    last_active_developer: "至少保留一位在用的开发人员。",
    last_active_user: "至少保留一位在用人员。",
    developer_role_required: "此操作需要开发角色。",
    admin_role_required: "此操作需要管理权限。",
    agent_model_not_available: "该 provider／模型不在全局 Pi models.json 中。",
    agent_thinking_level_not_supported: "该模型不支持所选的思考级别。",
    agent_api_key_required: "请填写 API Key；更换 provider 时需要新的 API Key，或清除凭据。",
    global_configuration_has_running_issues: "有工单正在运行，请稍后重试。",
    resource_in_use: "配置仍被使用，不能删除。",
  };
  return messages[code] ?? code;
}
