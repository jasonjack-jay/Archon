import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { costRollCommand, costSummaryCommand } from './cost';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: mock(() => '/home/test/.archon'),
  getProjectLogsPath: mock(
    (owner: string, repo: string) => `/home/test/.archon/workspaces/${owner}/${repo}/logs`
  ),
  resolveProjectRootFromCwd: mock(() => null),
}));

mock.module('@archon/git', () => ({
  findRepoRoot: mock(() => Promise.resolve(null)),
  getRemoteUrl: mock(() => Promise.resolve(null)),
}));

interface JsonlEvent {
  type: string;
  ts: string;
  workflow_name?: string;
  step?: string;
  node_type?: string;
  gate_class?: string;
  duration_ms?: number;
  cost_usd?: number;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    total?: number;
    cost?: number;
  };
}

describe('cost commands', () => {
  let testDir: string;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `cost-command-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeRun(runId: string, events: JsonlEvent[]): Promise<void> {
    const contents = events.map(event => JSON.stringify(event)).join('\n');
    await writeFile(join(testDir, `${runId}.jsonl`), contents === '' ? '' : `${contents}\n`);
  }

  function parseJsonLogCall<T>(callIndex = 0): T {
    return JSON.parse(consoleLogSpy.mock.calls[callIndex][0] as string) as T;
  }

  it('summary returns zero totals for an empty file', async () => {
    await writeFile(join(testDir, 'empty-run.jsonl'), '');

    const exitCode = await costSummaryCommand('empty-run', {
      cwd: testDir,
      json: true,
      logDir: testDir,
    });

    expect(exitCode).toBe(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(parseJsonLogCall<Record<string, unknown>>()).toEqual({
      total_wall_ms: 0,
      total_cost_usd: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_tokens_cached: 0,
      node_count: 0,
      gates: [],
      top_nodes_by_wall: [],
    });
  });

  it('summary aggregates a single node with cost and cached tokens', async () => {
    await writeRun('single-run', [
      {
        type: 'workflow_start',
        ts: '2026-05-19T10:00:00.000Z',
        workflow_name: 'single-workflow',
      },
      {
        type: 'node_complete',
        ts: '2026-05-19T10:00:01.000Z',
        step: 'draft',
        node_type: 'prompt',
        duration_ms: 1250,
        cost_usd: 0.42,
        tokens: { input: 100, output: 25, cached: 12, total: 137, cost: 0.42 },
      },
    ]);

    const exitCode = await costSummaryCommand('single-run', {
      cwd: testDir,
      json: true,
      logDir: testDir,
    });

    expect(exitCode).toBe(0);
    expect(parseJsonLogCall<Record<string, unknown>>()).toEqual({
      total_wall_ms: 1250,
      total_cost_usd: 0.42,
      total_tokens_in: 100,
      total_tokens_out: 25,
      total_tokens_cached: 12,
      node_count: 1,
      gates: [],
      top_nodes_by_wall: [
        {
          node_id: 'draft',
          node_type: 'prompt',
          wall_ms: 1250,
          cost_usd: 0.42,
        },
      ],
    });
  });

  it('summary handles multiple nodes with one missing cost and mixed node types', async () => {
    await writeRun('mixed-run', [
      {
        type: 'workflow_start',
        ts: '2026-05-19T11:00:00.000Z',
        workflow_name: 'mixed-workflow',
      },
      {
        type: 'node_complete',
        ts: '2026-05-19T11:00:01.000Z',
        step: 'plan',
        node_type: 'command',
        duration_ms: 700,
        cost_usd: 0.15,
        tokens: { input: 40, output: 10, total: 50, cost: 0.15 },
      },
      {
        type: 'node_complete',
        ts: '2026-05-19T11:00:02.000Z',
        step: 'lint',
        node_type: 'bash',
        duration_ms: 900,
        tokens: { input: 0, output: 0, cached: 0, total: 0 },
      },
      {
        type: 'node_complete',
        ts: '2026-05-19T11:00:03.000Z',
        step: 'report',
        node_type: 'script',
        duration_ms: 300,
        cost_usd: 0.05,
        tokens: { input: 5, output: 20, total: 25, cost: 0.05 },
      },
    ]);

    const exitCode = await costSummaryCommand('mixed-run', {
      cwd: testDir,
      json: true,
      logDir: testDir,
    });

    expect(exitCode).toBe(0);
    expect(parseJsonLogCall<Record<string, unknown>>()).toEqual({
      total_wall_ms: 1900,
      total_cost_usd: 0.2,
      total_tokens_in: 45,
      total_tokens_out: 30,
      total_tokens_cached: 0,
      node_count: 3,
      gates: [],
      top_nodes_by_wall: [
        { node_id: 'lint', node_type: 'bash', wall_ms: 900, cost_usd: 0 },
        { node_id: 'plan', node_type: 'command', wall_ms: 700, cost_usd: 0.15 },
        { node_id: 'report', node_type: 'script', wall_ms: 300, cost_usd: 0.05 },
      ],
    });
  });

  it('summary includes gates array for successful gate completions', async () => {
    await writeRun('gate-success-run', [
      {
        type: 'workflow_start',
        ts: '2026-05-19T12:00:00.000Z',
        workflow_name: 'gate-workflow',
      },
      {
        type: 'node_complete',
        ts: '2026-05-19T12:00:01.000Z',
        step: 'gate-a',
        node_type: 'gate',
        gate_class: 'assert-closes-keyword',
        duration_ms: 180,
      },
      {
        type: 'node_complete',
        ts: '2026-05-19T12:00:02.000Z',
        step: 'prompt-a',
        node_type: 'prompt',
        duration_ms: 20,
        cost_usd: 0.1,
        tokens: { input: 5, output: 2, total: 7, cost: 0.1 },
      },
    ]);

    const exitCode = await costSummaryCommand('gate-success-run', {
      cwd: testDir,
      json: true,
      logDir: testDir,
    });

    expect(exitCode).toBe(0);
    expect(parseJsonLogCall<Record<string, unknown>>()).toEqual({
      total_wall_ms: 200,
      total_cost_usd: 0.1,
      total_tokens_in: 5,
      total_tokens_out: 2,
      total_tokens_cached: 0,
      node_count: 2,
      gates: [
        {
          class: 'assert-closes-keyword',
          count: 1,
          failures: 0,
          total_wall_ms: 180,
        },
      ],
      top_nodes_by_wall: [
        { node_id: 'gate-a', node_type: 'gate', wall_ms: 180, cost_usd: 0 },
        { node_id: 'prompt-a', node_type: 'prompt', wall_ms: 20, cost_usd: 0.1 },
      ],
    });
  });

  it('summary counts gate failures from node_error lines separately', async () => {
    await writeRun('gate-failure-run', [
      {
        type: 'workflow_start',
        ts: '2026-05-19T13:00:00.000Z',
        workflow_name: 'gate-workflow',
      },
      {
        type: 'node_complete',
        ts: '2026-05-19T13:00:01.000Z',
        step: 'gate-pass',
        node_type: 'gate',
        gate_class: 'assert-closes-keyword',
        duration_ms: 90,
      },
      {
        type: 'node_error',
        ts: '2026-05-19T13:00:02.000Z',
        step: 'gate-fail',
        gate_class: 'assert-closes-keyword',
      },
      {
        type: 'node_error',
        ts: '2026-05-19T13:00:03.000Z',
        step: 'other-fail',
        gate_class: 'assert-no-tabs',
      },
    ]);

    const exitCode = await costSummaryCommand('gate-failure-run', {
      cwd: testDir,
      json: true,
      logDir: testDir,
    });

    expect(exitCode).toBe(0);
    expect(parseJsonLogCall<Record<string, unknown>>()).toEqual({
      total_wall_ms: 90,
      total_cost_usd: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_tokens_cached: 0,
      node_count: 1,
      gates: [
        {
          class: 'assert-closes-keyword',
          count: 1,
          failures: 1,
          total_wall_ms: 90,
        },
        {
          class: 'assert-no-tabs',
          count: 0,
          failures: 1,
          total_wall_ms: 0,
        },
      ],
      top_nodes_by_wall: [{ node_id: 'gate-pass', node_type: 'gate', wall_ms: 90, cost_usd: 0 }],
    });
  });

  it('roll groups runs by workflow and computes avg cost plus p50/p95 wall time', async () => {
    await writeRun('run-a', [
      {
        type: 'workflow_start',
        ts: '2026-05-18T09:00:00.000Z',
        workflow_name: 'ship',
      },
      {
        type: 'node_complete',
        ts: '2026-05-18T09:00:02.000Z',
        step: 'plan',
        node_type: 'command',
        duration_ms: 100,
        cost_usd: 1,
        tokens: { input: 10, output: 1, total: 11, cost: 1 },
      },
    ]);
    await writeRun('run-b', [
      {
        type: 'workflow_start',
        ts: '2026-05-18T10:00:00.000Z',
        workflow_name: 'ship',
      },
      {
        type: 'node_complete',
        ts: '2026-05-18T10:00:03.000Z',
        step: 'plan',
        node_type: 'command',
        duration_ms: 200,
        cost_usd: 2,
        tokens: { input: 20, output: 2, total: 22, cost: 2 },
      },
    ]);
    await writeRun('run-c', [
      {
        type: 'workflow_start',
        ts: '2026-05-18T11:00:00.000Z',
        workflow_name: 'ship',
      },
      {
        type: 'node_complete',
        ts: '2026-05-18T11:00:04.000Z',
        step: 'plan',
        node_type: 'command',
        duration_ms: 900,
        cost_usd: 3,
        tokens: { input: 30, output: 3, total: 33, cost: 3 },
      },
    ]);
    await writeRun('run-d', [
      {
        type: 'workflow_start',
        ts: '2026-05-18T12:00:00.000Z',
        workflow_name: 'audit',
      },
      {
        type: 'node_complete',
        ts: '2026-05-18T12:00:02.000Z',
        step: 'scan',
        node_type: 'script',
        duration_ms: 400,
        cost_usd: 0.5,
        tokens: { input: 7, output: 4, total: 11, cost: 0.5 },
      },
    ]);

    const exitCode = await costRollCommand({
      cwd: testDir,
      json: true,
      logDir: testDir,
    });

    expect(exitCode).toBe(0);
    expect(parseJsonLogCall<Array<Record<string, unknown>>>()).toEqual([
      {
        workflow_name: 'audit',
        runs: 1,
        avg_cost_usd: 0.5,
        p50_wall_ms: 400,
        p95_wall_ms: 400,
        total_tokens_in: 7,
        total_tokens_out: 4,
        gates_by_class: {},
      },
      {
        workflow_name: 'ship',
        runs: 3,
        avg_cost_usd: 2,
        p50_wall_ms: 200,
        p95_wall_ms: 900,
        total_tokens_in: 60,
        total_tokens_out: 6,
        gates_by_class: {},
      },
    ]);
  });

  it('roll aggregates gates_by_class once per run with failure counts', async () => {
    await writeRun('gate-roll-a', [
      {
        type: 'workflow_start',
        ts: '2026-05-18T13:00:00.000Z',
        workflow_name: 'gate-roll',
      },
      {
        type: 'node_complete',
        ts: '2026-05-18T13:00:01.000Z',
        step: 'gate-a-1',
        node_type: 'gate',
        gate_class: 'assert-closes-keyword',
        duration_ms: 100,
      },
      {
        type: 'node_complete',
        ts: '2026-05-18T13:00:02.000Z',
        step: 'gate-a-2',
        node_type: 'gate',
        gate_class: 'assert-closes-keyword',
        duration_ms: 50,
      },
      {
        type: 'node_error',
        ts: '2026-05-18T13:00:03.000Z',
        step: 'gate-a-3',
        gate_class: 'assert-closes-keyword',
      },
      {
        type: 'node_error',
        ts: '2026-05-18T13:00:04.000Z',
        step: 'gate-a-4',
        gate_class: 'assert-no-tabs',
      },
    ]);
    await writeRun('gate-roll-b', [
      {
        type: 'workflow_start',
        ts: '2026-05-18T14:00:00.000Z',
        workflow_name: 'gate-roll',
      },
      {
        type: 'node_complete',
        ts: '2026-05-18T14:00:01.000Z',
        step: 'gate-b-1',
        node_type: 'gate',
        gate_class: 'assert-closes-keyword',
        duration_ms: 75,
      },
    ]);

    const exitCode = await costRollCommand({
      cwd: testDir,
      json: true,
      logDir: testDir,
    });

    expect(exitCode).toBe(0);
    expect(parseJsonLogCall<Array<Record<string, unknown>>>()).toEqual([
      {
        workflow_name: 'gate-roll',
        runs: 2,
        avg_cost_usd: 0,
        p50_wall_ms: 75,
        p95_wall_ms: 150,
        total_tokens_in: 0,
        total_tokens_out: 0,
        gates_by_class: {
          'assert-closes-keyword': { runs_fired: 2, runs_failed: 1 },
          'assert-no-tabs': { runs_fired: 1, runs_failed: 1 },
        },
      },
    ]);
  });
});
