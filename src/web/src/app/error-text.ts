import { sharedConfig } from "../../../../issue-pilot.config.ts";
import { errorMessage } from "../data/client";

const megabytes = (bytes: number) => `${Math.floor(bytes / 1024 / 1024)} MB`;

export type ErrorTexts = Readonly<Record<string, string>>;

/**
 * One user-facing message per server or client error code. Contexts pass overrides only where the
 * same code needs different advice; unknown codes stay visible as diagnostics unless a context
 * supplies its own fallback.
 */
const messages: ErrorTexts = {
  // Configuration and administration
  configuration_changed: "配置已被更新，请重新加载后再保存。当前输入已保留。",
  "invalid_application_parameter:dingtalkAttachmentHosts": "钉钉附件主机每行填一个主机名，不含协议、端口或路径，最多 100 个且不能重复。",
  "invalid_application_parameter:networkAllowedDomains": "Agent 网络基础白名单包含无效或重复的域名，最多填写 100 个。",
  invalid_issue_search_account_id: "请填写 32 位十六进制的 Cloudflare Account ID。",
  invalid_issue_search_token: "请填写有效的 Cloudflare API Token。",
  issue_search_account_token_required: "更换 Cloudflare 账号需要填写新 Token，或关闭搜索并清除旧 Token。",
  issue_search_credentials_required: "启用搜索需要填写 Cloudflare Account ID 和 API Token。",
  issue_sandbox_network_sync_failed: "参数已保存，但 Agent 沙箱网络规则同步失败；下次启动沙箱时会重试。如持续出现请联系管理员。",
  conflict: "该邮箱或仓库地址已存在。",
  invalid_user_email: "请填写有效的邮箱地址。",
  invalid_repository_url: "请填写有效的 HTTPS 或 SSH 仓库地址。",
  invalid_repository_group: "请填写 1 至 64 个字符的分组名称，不能包含控制字符。",
  repository_is_used_by_services: "仓库仍被服务使用，请先解除关联。",
  repository_required: "请至少选择一个关联仓库。",
  invalid_service_deployment: "环境部署配置包含无法识别的字段，请刷新页面后重新提交。",
  deployment_save_failed: "环境部署保存失败，请重新加载确认当前配置后重试；如持续出现请联系管理员。",
  service_is_used_by_issues: "已有工单属于该服务，不能删除。工单记录需要保留该服务。",
  deployment_is_used_by_issues: "已有工单属于要移除的环境部署，不能移除。请保留该环境部署后再保存。",
  service_has_running_issues: "相关环境有运行中的工单，请稍后重试。",
  mcp_has_running_issues: "MCP 连接变更会影响所有工单，当前有工单正在运行，请稍后重试。",
  mcp_configuration_save_failed: "MCP 连接保存失败，请稍后重试；如持续失败请联系管理员查看服务日志。",
  capability_has_running_issues: "有使用该能力的工单正在处理，请等待处理结束或先中止 Agent 后重试。",
  mcp_name_conflict: "MCP 连接名称已存在，请换一个名称。",
  global_configuration_has_running_issues: "有工单正在运行，请稍后重试。",
  resource_in_use: "配置仍被使用，不能删除。",
  last_active_admin: "至少保留一位在用的开发管理人员。",
  last_active_developer: "至少保留一位在用的开发人员。",
  workspace_statistics_refresh_too_frequent: "统计刚刚重新采样过，请稍后再试。",
  sls_scope_targets_mismatch: "SLS 顶层地域、项目和日志库必须与第一个查询目标一致。",
  current_subject_required: "网关没有提供当前用户身份，请联系管理员检查网关配置。",
  last_active_user: "至少保留一位在用人员。",
  developer_role_required: "此操作需要开发角色。",
  admin_role_required: "此操作需要管理权限。",
  agent_model_not_available: "该 provider／模型不在全局 Pi models.json 中。",
  agent_thinking_level_not_supported: "该模型不支持所选的思考级别。",
  agent_api_key_required: "请填写 API Key；更换 provider 时需要新的 API Key，或清除凭据。",
  database_unavailable: "数据库暂时不可用，请稍后重试；如持续出现请联系管理员。",
  database_operation_failed: "数据库操作失败，请稍后重试；如持续出现请联系管理员。",

  // Credentials and capabilities
  model_api_key_not_configured: "尚未配置模型 API Key，请在用户配置中设置个人或共享 API Key 后重试。",
  dms_credentials_not_configured: "尚未配置 DMS 凭据，请在用户配置中设置个人或共享 DMS 凭据后重试。",
  personal_dms_credentials_incomplete: "个人 DMS 凭据不完整，请补齐或清除后使用共享凭据。",
  sls_credentials_not_configured: "尚未配置 SLS 凭据，请在用户配置中设置个人或共享 SLS 凭据后重试。",
  personal_sls_credentials_incomplete: "个人 SLS 凭据不完整，请重新设置完整凭据后重试。",
  issue_developer_owner_required: "开发工单的处理人（未分配时为报告人）必须是在用的开发人员。",
  issue_credential_owner_inactive: "工单处理人（未分配时为报告人）已停用，请更换处理人后重试。",
  invalid_git_private_key: "SSH 私钥格式无效，请粘贴完整私钥，以 -----BEGIN … PRIVATE KEY----- 开头。",
  user_credentials_save_failed: "凭证保存失败，请重新加载确认当前状态后重试；如持续出现请联系管理员。",
  user_git_ssh_credentials_required: "工单处理人（未分配时为报告人）尚未配置个人 SSH Key，请在“我的凭证”中设置后重试。",
  development_repository_ssh_url_required: "含开发环境部署的服务必须使用 SSH 仓库地址（如 git@host:group/repo.git）。",
  personal_git_ssh_url_required: "开发处理只能通过 SSH 访问仓库，请联系管理员将仓库地址改为 SSH 格式（如 git@host:group/repo.git）。",
  dms_scope_resolve_failed: "无法连接 DMS 解析实例或数据库，请检查 DMS 地址和网络后重试；如持续出现请联系管理员。",
  sls_result_too_large_narrow_query: `SLS 查询结果超过 ${Math.floor(sharedConfig.limits.capability.inlineResultBytes / 1024)} KiB 上限，请缩短时间范围、增加过滤条件或在 SQL 分析中使用 LIMIT。`,
  dms_mcp_result_too_large_use_export: `DMS 查询结果超过 ${Math.floor(sharedConfig.limits.capability.inlineResultBytes / 1024)} KiB 上限，请加 LIMIT 或更严格的过滤条件，或改用导出。`,
  dingtalk_mcp_not_configured: "尚未启用钉钉 MCP 连接，请联系管理员在全局 MCP 连接中配置。",

  // Issue lifecycle and editing
  issue_not_found: "工单不存在或已被删除。",
  issue_already_running: "工单正在处理，请稍后重试。",
  invalid_subject: "处理人或抄送人包含已停用的用户，请重新选择后保存。",
  invalid_issue_status_transition: "工单状态已变化，请按最新状态操作。",
  issue_not_retryable: "工单当前无需重试，请刷新查看最新状态。",
  issue_edit_conflict: "工单已被修改，请重新载入最新工单。",
  invalid_reset_version: "缺少有效的会话版本，请刷新页面后重新打开编辑工单。",
  issue_edit_enqueue_unconfirmed: "工单已保存，但无法确认 Agent 是否已入队，请重新读取",
  issue_edit_reset_notification_failed: "工单已保存并重置，但会话通知失败，请重新读取",
  issue_edit_summary_unavailable: "工单已保存，但未能读取最新摘要，请重新读取",
  resolved_issue_cannot_reset_session: "请先重开工单。",
  agent_session_changed: "会话已更新，请重新打开编辑工单。",
  agent_session_not_found: "暂无可重置的会话。",
  invalid_service_for_work_mode: "所选服务不支持此处理方式。",
  related_issue_limit_exceeded: `关联工单最多 ${sharedConfig.limits.relatedIssues} 个。`,
  related_issue_context_unavailable: "本工单或所选关联工单的工作区尚未就绪，请等待准备完成后重试。",
  related_issue_update_not_allowed: "已解决的工单不能修改关联，请先重开。",
  invalid_related_issues: "所选关联工单无效，请重新选择。",
  attachment_not_found: "附件不存在或已被删除，请刷新工单后重试。",
  issue_work_file_not_found: "工单文件不存在或已被删除，请刷新文件列表后重试。",

  // Code browser
  source_file_changed: "文件已被其他操作修改；你的草稿已保留，请重新读取后合并。",

  // Scope transitions
  scope_transition_plan_stale: "工单或配置已变化，预检已失效，请重新预检。",
  issue_not_convertible_to_development: "当前工单不能转为开发处理：需为待处理或待确认的分析工单，且工作区已就绪。",
  issue_not_migratable_between_development_scopes: "当前开发工单不能迁移：需为待处理或待确认状态，且工作区已就绪。",
  service_not_available_in_environment: "所选服务在目标环境没有部署。",
  development_production_deployment_required: "开发处理需要所选服务具备正式环境部署。",
  selected_service_has_no_repository: "所选服务没有配置仓库，不能用于开发处理。",

  // Agent execution and messages
  agent_message_scope_changed: "历史排队消息的处理范围已变更，已停止恢复。请核对历史输入后重试，或按当前范围重新发送。",
  model_response_failed: "模型响应中断，处理未完成。已有对话和文件已保留，请核对结果后重试处理。",
  agent_run_failed: "处理未完成：发生了未识别的错误。已有对话和文件已保留，请核对结果后重试处理。",
  agent_message_too_long: `消息超过 ${sharedConfig.limits.agentMessageChars.toLocaleString()} 字符上限，请分段发送。`,
  invalid_agent_message: "消息内容无效，请输入文字后重新发送。",
  agent_message_outcome_unknown: "无法确认这条消息是否已执行。请先查看对话和结果，再决定是否重发。",
  agent_session_file_incomplete: "会话文件不完整，消息未接收。请保留草稿并联系管理员检查会话文件。",
  agent_session_file_missing: "会话文件缺失，消息未接收。请保留草稿并联系管理员检查会话绑定。",
  issue_root_missing: "工单目录缺失，消息未接收。请保留草稿并联系管理员恢复原目录。",
  invalid_issue_root: "工单目录异常，消息未接收。请保留草稿并联系管理员检查目录。",
  issue_workspace_missing: "工单工作区记录缺失，请联系管理员检查。",
  issue_not_running: "处理结束时工单已不在处理中，结果未能登记。已有对话和文件已保留，请刷新后核对结果。",
  issue_scope_changed: "工单已解决或处理范围已变更，操作已停止。请刷新后按最新范围重试。",
  resolved_issue_cannot_run_agent: "工单已解决，请先重开后再发送。",
  agent_event_connection_failed: "事件连接中断，正在自动重连",
  agent_event_protocol_error: "收到无法识别的 Agent 事件",
  agent_message_failed: "消息发送失败，请重试",
  invalid_agent_image: `只能粘贴 PNG、JPEG、GIF 或 WebP 图片，最多 ${sharedConfig.limits.agentImage.files} 张`,
  agent_image_limit_exceeded: `图片最多 ${sharedConfig.limits.agentImage.files} 张，单张不超过 ${megabytes(sharedConfig.limits.agentImage.fileBytes)}，合计不超过 ${megabytes(sharedConfig.limits.agentImage.requestBytes)}`,
  issue_refresh_failed: "工单状态刷新失败，等待下次连接重试",
};

/** Maps an error (or its code) to display text: context overrides, then the shared table, then the fallback or the code itself. */
export function errorText(error: unknown, overrides?: ErrorTexts, fallback?: string): string {
  const code = errorMessage(error);
  return overrides?.[code] ?? messages[code] ?? fallback ?? code;
}
