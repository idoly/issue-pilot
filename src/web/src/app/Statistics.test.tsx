import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, expect, test, vi } from 'vitest';
import { createSignal } from 'solid-js';

import { loadWorkspaceStats, type IssueListItem, type WorkspaceStats } from '../data/client';
import { Statistics } from './Statistics';

vi.mock('../data/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../data/client')>(),
  loadWorkspaceStats: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function issue(overrides: Partial<IssueListItem>): IssueListItem {
  return { id: 'fixture', title: 'Fixture', priority: 'p1', type: 'smart_analysis', status: 'open', assignee: null, assigneeSubject: null, service: { key: 'orders', name: 'Orders' }, environmentKey: 'prod', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
}

for (const reversed of [false, true]) test(`team statistics keep a real unassigned account separate from unassigned Issues in ${reversed ? 'reverse' : 'forward'} order`, async () => {
  const issues = [
    issue({ id: 'unassigned-issue', status: 'resolved' }),
    issue({ id: 'user-open-1', assigneeSubject: 'unassigned', assignee: '真实处理人' }),
    issue({ id: 'user-open-2', assigneeSubject: 'unassigned', assignee: '真实处理人' }),
    issue({ id: 'user-resolved', assigneeSubject: 'unassigned', assignee: '真实处理人', status: 'resolved' }),
  ];
  render(() => <Statistics issues={reversed ? [...issues].reverse() : issues} />);
  fireEvent.click(screen.getByRole('tab', { name: '团队' }));
  const section = (await screen.findByRole('heading', { name: '个人处理情况' })).closest('section')!;
  const userRow = within(section).getByText('真实处理人').parentElement!;
  const unassignedRow = within(section).getByText('未分配').parentElement!;
  expect([...userRow.querySelectorAll('span')].map(cell => cell.textContent)).toEqual(['1', '2', '3']);
  expect([...unassignedRow.querySelectorAll('span')].map(cell => cell.textContent)).toEqual(['1', '0', '1']);
  expect(section.querySelectorAll('.assignee-table > div')).toHaveLength(3);
  expect(loadWorkspaceStats).not.toHaveBeenCalled();
});

test('team statistics use account identity rather than display name and react to reassignment', async () => {
  const [issues, setIssues] = createSignal([
    issue({ id: 'first', assigneeSubject: 'person-a', assignee: '同名', status: 'resolved' }),
    issue({ id: 'second', assigneeSubject: 'person-b', assignee: '同名' }),
    issue({ id: 'third' }),
  ], { ownedWrite: true });
  render(() => <Statistics issues={issues()} />);
  fireEvent.click(screen.getByRole('tab', { name: '团队' }));
  expect(screen.getAllByText('同名')).toHaveLength(2);
  setIssues(current => current.map(row => row.id === 'second' ? { ...row, assigneeSubject: 'person-a' } : row));
  await waitFor(() => expect(screen.getAllByText('同名')).toHaveLength(1));
  const row = screen.getByText('同名').parentElement!;
  expect([...row.querySelectorAll('span')].map(cell => cell.textContent)).toEqual(['1', '1', '2']);
  expect(screen.getByText('未分配')).toBeTruthy();
});

test('period statistics use creation time rather than a recent update and recompute when the period changes', async () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  render(() => <Statistics issues={[
    issue({ id: 'recent', createdAt: daysAgo(2) }),
    issue({ id: 'earlier', createdAt: daysAgo(10), status: 'resolved' }),
    issue({ id: 'old-but-updated', createdAt: daysAgo(40), status: 'resolved' }),
  ]} />);
  fireEvent.click(screen.getByRole('tab', { name: '产出' }));
  const metric = (label: string) => screen.getByText(label).parentElement!.querySelector('strong')!.textContent;
  expect(metric('周期新增')).toBe('2'); expect(metric('周期解决')).toBe('1'); expect(metric('解决率')).toBe('50%');
  fireEvent.click(screen.getByRole('combobox', { name: '统计周期' }));
  fireEvent.click(await screen.findByRole('option', { name: '最近 7 天' }));
  await waitFor(() => expect(metric('周期新增')).toBe('1'));
  expect(metric('周期解决')).toBe('0'); expect(metric('解决率')).toBe('0%');
  fireEvent.click(screen.getByRole('combobox', { name: '统计周期' }));
  fireEvent.click(await screen.findByRole('option', { name: '最近 90 天' }));
  await waitFor(() => expect(metric('周期新增')).toBe('3'));
  expect(metric('周期解决')).toBe('2'); expect(metric('解决率')).toBe('66.7%');
  expect(loadWorkspaceStats).not.toHaveBeenCalled();
});

test('distinguishes retained files from reclaim candidates and actual safety failures', async () => {
  const stats: WorkspaceStats = {
    sampledAt: "2026-10-25T08:00:00.000Z",
    sharedGitBytes: 3 * 1024,
    totalBytes: 17 * 1024,
    policy: {
      retentionHours: 168,
      highWaterBytes: 20 * 1024 ** 3,
      targetBytes: 16 * 1024 ** 3,
      maintenanceIntervalMinutes: 15,
    },
    workspaces: [
      {
        issueKey: 'ISSUE-20261023-001', issueStatus: 'open', workspaceStatus: 'ready',
        resolvedAt: null, bytes: 1024, releasable: false,
        blockedReason: 'workspace_not_development',
      },
      {
        issueKey: 'ISSUE-20261023-002', issueStatus: 'resolved', workspaceStatus: 'stopped',
        resolvedAt: new Date().toISOString(), bytes: 1024, releasable: false,
        blockedReason: 'workspace_released',
      },
      {
        issueKey: 'ISSUE-20261023-003', issueStatus: 'resolved', workspaceStatus: 'ready',
        resolvedAt: new Date().toISOString(), bytes: 8 * 1024, releasable: true,
        blockedReason: null,
      },
      {
        issueKey: 'ISSUE-20261023-004', issueStatus: 'resolved', workspaceStatus: 'failed',
        resolvedAt: new Date().toISOString(), bytes: 1024, releasable: false,
        blockedReason: 'workspace_repository_missing',
      },
      {
        issueKey: 'ISSUE-20261023-005', issueStatus: 'resolved', workspaceStatus: 'stopped',
        resolvedAt: new Date().toISOString(), bytes: 1024, releasable: false,
        blockedReason: 'workspace_runtime_restore_failed',
      },
      {
        issueKey: 'ISSUE-20261023-006', issueStatus: 'resolved', workspaceStatus: 'stopped',
        resolvedAt: new Date().toISOString(), bytes: 1024, releasable: false,
        blockedReason: 'workspace_runtime_not_ready',
      },
      ...['workspace_git_binding_invalid', 'issue_runtime_entry_changed', 'workspace_probe_timeout', 'Command failed: git /private/example.git'].map((blockedReason, index): WorkspaceStats['workspaces'][number] => ({
        issueKey: `ISSUE-20261024-${980 + index}`, issueStatus: 'resolved', workspaceStatus: 'failed',
        resolvedAt: new Date().toISOString(), bytes: 1024, releasable: false, blockedReason,
      })),
    ],
  };
  vi.mocked(loadWorkspaceStats).mockResolvedValue(stats);
  render(() => <Statistics issues={[]} />);
  fireEvent.click(screen.getByRole('tab', { name: '资源' }));
  expect(await screen.findByText('只读工单，保留工作文件')).toBeTruthy();
  expect(screen.getByText('代码已释放，保留工作文件')).toBeTruthy();
  expect(screen.getByText('仓库目录缺失')).toBeTruthy();
  expect(screen.getByText('代码已释放，视图恢复失败')).toBeTruthy();
  expect(screen.getByText('代码已释放，运行视图待恢复')).toBeTruthy();
  expect(screen.getByText('Git 元数据链接失效').title).toContain('workspace_git_binding_invalid');
  expect(screen.getByText('运行视图引用已变化')).toBeTruthy();
  expect(screen.getByText('检查失败（workspace_probe_timeout）')).toBeTruthy();
  expect(screen.getByText('状态检查失败，请查看服务日志')).toBeTruthy();
  expect(screen.queryByText(/private\/example/)).toBeNull();
  const candidates = screen.getByText('回收候选占用').parentElement;
  expect(candidates).toBeTruthy();
  expect(within(candidates!).getByText('8.0 KB')).toBeTruthy();
  expect(screen.getByText('回收候选占用').title).toContain('实际释放量');
  expect(within(screen.getByText('工单目录占用').parentElement!).getByText('17 KB')).toBeTruthy();
  expect(within(screen.getByText('共享 Git 占用').parentElement!).getByText('3.0 KB')).toBeTruthy();
  expect(screen.getByText('回收触发线')).toBeTruthy();
});

test('storage loads only on its first visit and explicit refresh bypasses the server snapshot', async () => {
  const stats: WorkspaceStats = { sampledAt: '2026-10-25T08:00:00.000Z', totalBytes: 0, sharedGitBytes: 0, policy: { retentionHours: 168, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMinutes: 15 }, workspaces: [] };
  vi.mocked(loadWorkspaceStats).mockResolvedValue(stats);
  render(() => <Statistics issues={[]} />);
  expect(loadWorkspaceStats).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: '资源' }));
  await screen.findByText('当前没有占用空间的工单');
  expect(loadWorkspaceStats).toHaveBeenCalledTimes(1); expect(vi.mocked(loadWorkspaceStats).mock.calls[0]![1]).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: '团队' })); fireEvent.click(screen.getByRole('tab', { name: '资源' }));
  expect(loadWorkspaceStats).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新统计' })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: '刷新统计' }));
  await waitFor(() => expect(loadWorkspaceStats).toHaveBeenCalledTimes(2)); expect(vi.mocked(loadWorkspaceStats).mock.calls[1]![1]).toBe(true);
});

test('storage failures can be retried without visiting another page', async () => {
  vi.mocked(loadWorkspaceStats).mockRejectedValueOnce(new Error('stats_unavailable')).mockResolvedValue({ sampledAt: '2026-10-25T08:00:00.000Z', totalBytes: 0, sharedGitBytes: 0, policy: { retentionHours: null, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMinutes: 0 }, workspaces: [] });
  render(() => <Statistics issues={[]} />); fireEvent.click(screen.getByRole('tab', { name: '资源' }));
  expect((await screen.findByRole('alert')).textContent).toContain('stats_unavailable');
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新统计' })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: '刷新统计' }));
  await screen.findByText('当前没有占用空间的工单'); expect(screen.queryByRole('alert')).toBeNull();
});
