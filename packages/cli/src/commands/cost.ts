import { watch, type Dirent } from 'fs';
import { open, readFile, readdir, stat } from 'fs/promises';
import { join, relative } from 'path';
import {
  createLogger,
  getArchonHome,
  getProjectLogsPath,
  resolveProjectRootFromCwd,
} from '@archon/paths';
import { findRepoRoot, getRemoteUrl } from '@archon/git';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.cost');
  return cachedLog;
}

interface TokenUsageLike {
  input?: number;
  output?: number;
  cached?: number;
}

interface WorkflowLogEvent {
  type?: string;
  ts?: string;
  workflow_name?: string;
  step?: string;
  node_type?: string;
  duration_ms?: number;
  cost_usd?: number;
  tokens?: TokenUsageLike;
}

interface CostCommandOptions {
  cwd: string;
  json?: boolean;
  logDir?: string;
}

interface CostRollOptions extends CostCommandOptions {
  since?: string;
  limit?: number;
}

interface CostSummary {
  total_wall_ms: number;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens_cached: number;
  node_count: number;
  top_nodes_by_wall: {
    node_id?: string;
    node_type?: string;
    wall_ms: number;
    cost_usd: number;
  }[];
}

interface RunAggregate {
  workflowName: string;
  ts: string;
  totalCostUsd: number;
  totalWallMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

interface RollupGroup {
  workflow_name: string;
  runs: number;
  avg_cost_usd: number;
  p50_wall_ms: number;
  p95_wall_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseEvent(line: string): WorkflowLogEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;

    const rawTokens = parsed.tokens;
    const tokens = isRecord(rawTokens)
      ? {
          input: toNumber(rawTokens.input),
          output: toNumber(rawTokens.output),
          cached: toNumber(rawTokens.cached),
        }
      : undefined;

    return {
      type: toStringValue(parsed.type),
      ts: toStringValue(parsed.ts),
      workflow_name: toStringValue(parsed.workflow_name),
      step: toStringValue(parsed.step),
      node_type: toStringValue(parsed.node_type),
      duration_ms: toNumber(parsed.duration_ms),
      cost_usd: toNumber(parsed.cost_usd),
      tokens,
    };
  } catch (error) {
    getLog().warn({ err: error as Error, line }, 'cost.invalid_jsonl_line');
    return null;
  }
}

function parseJsonl(content: string): WorkflowLogEvent[] {
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(parseEvent)
    .filter((event): event is WorkflowLogEvent => event !== null);
}

async function readEvents(filePath: string): Promise<WorkflowLogEvent[] | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    if (content.trim() === '') return [];
    return parseJsonl(content);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function buildZeroSummary(): CostSummary {
  return {
    total_wall_ms: 0,
    total_cost_usd: 0,
    total_tokens_in: 0,
    total_tokens_out: 0,
    total_tokens_cached: 0,
    node_count: 0,
    top_nodes_by_wall: [],
  };
}

function printSummary(summary: CostSummary, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(summary));
    return;
  }

  console.log(`Total wall ms: ${String(summary.total_wall_ms)}`);
  console.log(`Total cost usd: ${String(summary.total_cost_usd)}`);
  console.log(`Total tokens in: ${String(summary.total_tokens_in)}`);
  console.log(`Total tokens out: ${String(summary.total_tokens_out)}`);
  console.log(`Total tokens cached: ${String(summary.total_tokens_cached)}`);
  console.log(`Node count: ${String(summary.node_count)}`);
}

function computeNearestRank(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function parseOwnerRepoFromRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const normalized = remoteUrl.replace(/\.git$/, '');

  if (normalized.includes('://')) {
    try {
      const url = new URL(normalized);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2) return null;
      const owner = parts[parts.length - 2];
      const repo = parts[parts.length - 1];
      return owner && repo ? { owner, repo } : null;
    } catch {
      return null;
    }
  }

  const scpMatch = /^[^:]+:(.+)$/.exec(normalized);
  if (!scpMatch) return null;
  const parts = scpMatch[1]?.split('/').filter(Boolean) ?? [];
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  return owner && repo ? { owner, repo } : null;
}

function parseOwnerRepoFromProjectRoot(
  projectRoot: string
): { owner: string; repo: string } | null {
  const workspacesRoot = join(getArchonHome(), 'workspaces');
  const parts = relative(workspacesRoot, projectRoot).split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

async function resolvePrimaryLogDir(cwd: string, explicitLogDir?: string): Promise<string | null> {
  if (explicitLogDir) return explicitLogDir;

  const projectRoot = resolveProjectRootFromCwd(cwd);
  if (projectRoot) {
    const ownerRepo = parseOwnerRepoFromProjectRoot(projectRoot);
    if (ownerRepo) return getProjectLogsPath(ownerRepo.owner, ownerRepo.repo);
  }

  const repoRoot = await findRepoRoot(cwd);
  if (!repoRoot) return null;
  const remoteUrl = await getRemoteUrl(repoRoot);
  if (!remoteUrl) return null;
  const ownerRepo = parseOwnerRepoFromRemote(remoteUrl);
  if (!ownerRepo) return null;
  return getProjectLogsPath(ownerRepo.owner, ownerRepo.repo);
}

async function resolveRollLogDirs(cwd: string, explicitLogDir?: string): Promise<string[]> {
  if (explicitLogDir) return [explicitLogDir];

  const primaryLogDir = await resolvePrimaryLogDir(cwd);
  if (primaryLogDir) return [primaryLogDir];

  const workspacesRoot = join(getArchonHome(), 'workspaces');
  let ownerEntries: Dirent[];
  try {
    ownerEntries = await readdir(workspacesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const logDirs: string[] = [];
  for (const ownerEntry of ownerEntries) {
    if (!ownerEntry.isDirectory()) continue;
    const ownerDir = join(workspacesRoot, ownerEntry.name);
    let repoEntries: Dirent[];
    try {
      repoEntries = await readdir(ownerDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const repoEntry of repoEntries) {
      if (!repoEntry.isDirectory()) continue;
      const logsDir = join(ownerDir, repoEntry.name, 'logs');
      try {
        const stats = await stat(logsDir);
        if (stats.isDirectory()) logDirs.push(logsDir);
      } catch {
        continue;
      }
    }
  }

  return logDirs;
}

async function listJsonlFiles(logDirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const logDir of logDirs) {
    let entries: Dirent[];
    try {
      entries = await readdir(logDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(join(logDir, entry.name));
      }
    }
  }
  return files;
}

function printRollup(groups: RollupGroup[], json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(groups));
    return;
  }

  for (const group of groups) {
    console.log(
      [
        group.workflow_name,
        `runs=${String(group.runs)}`,
        `avg_cost_usd=${String(group.avg_cost_usd)}`,
        `p50_wall_ms=${String(group.p50_wall_ms)}`,
        `p95_wall_ms=${String(group.p95_wall_ms)}`,
        `tokens_in=${String(group.total_tokens_in)}`,
        `tokens_out=${String(group.total_tokens_out)}`,
      ].join(' ')
    );
  }
}

export async function costSummaryCommand(runId: string, opts: CostCommandOptions): Promise<number> {
  const logDir = await resolvePrimaryLogDir(opts.cwd, opts.logDir);
  if (!logDir) {
    console.error('Unable to resolve workflow log directory.');
    return 1;
  }

  try {
    const events = await readEvents(join(logDir, `${runId}.jsonl`));
    const summary = buildZeroSummary();

    for (const event of events ?? []) {
      if (event.type !== 'node_complete') continue;
      const durationMs = event.duration_ms ?? 0;
      const costUsd = event.cost_usd ?? 0;
      summary.total_wall_ms += durationMs;
      summary.total_cost_usd += costUsd;
      summary.total_tokens_in += event.tokens?.input ?? 0;
      summary.total_tokens_out += event.tokens?.output ?? 0;
      summary.total_tokens_cached += event.tokens?.cached ?? 0;
      summary.node_count += 1;
      summary.top_nodes_by_wall.push({
        node_id: event.step,
        node_type: event.node_type,
        wall_ms: durationMs,
        cost_usd: costUsd,
      });
    }

    summary.top_nodes_by_wall.sort((a, b) => b.wall_ms - a.wall_ms);
    summary.top_nodes_by_wall = summary.top_nodes_by_wall.slice(0, 5);
    printSummary(summary, opts.json);
    return 0;
  } catch (error) {
    const err = error as Error;
    console.error(`Failed to read workflow log: ${err.message}`);
    return 1;
  }
}

export async function costTailCommand(runId: string, opts: CostCommandOptions): Promise<number> {
  const logDir = await resolvePrimaryLogDir(opts.cwd, opts.logDir);
  if (!logDir) {
    console.error('Unable to resolve workflow log directory.');
    return 1;
  }

  const filePath = join(logDir, `${runId}.jsonl`);
  let offset = 0;
  let trailing = '';

  try {
    const initialStats = await stat(filePath);
    offset = initialStats.size;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      console.error(`Failed to read workflow log: ${err.message}`);
      return 1;
    }
  }

  const watcher = watch(filePath, async eventType => {
    if (eventType !== 'change') return;

    try {
      const handle = await open(filePath, 'r');
      const fileStats = await handle.stat();
      if (fileStats.size < offset) {
        offset = 0;
        trailing = '';
      }
      const bytesToRead = fileStats.size - offset;
      if (bytesToRead <= 0) {
        await handle.close();
        return;
      }
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, offset);
      await handle.close();
      offset = fileStats.size;

      const chunk = trailing + buffer.toString('utf8');
      const lines = chunk.split('\n');
      trailing = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const event = parseEvent(trimmed);
        if (event?.type !== 'node_complete') continue;
        console.log(
          JSON.stringify({
            ts: event.ts,
            node_id: event.step,
            node_type: event.node_type,
            duration_ms: event.duration_ms,
            cost_usd: event.cost_usd,
            'tokens.input': event.tokens?.input,
            'tokens.output': event.tokens?.output,
          })
        );
      }
    } catch (error) {
      getLog().warn({ err: error as Error, filePath }, 'cost.tail_read_failed');
    }
  });

  await new Promise<void>(resolvePromise => {
    const onSigint = (): void => {
      watcher.close();
      process.off('SIGINT', onSigint);
      resolvePromise();
    };
    process.on('SIGINT', onSigint);
  });

  return 0;
}

export async function costRollCommand(opts: CostRollOptions): Promise<number> {
  const sinceTime = opts.since ? Date.parse(opts.since) : undefined;
  if (opts.since && Number.isNaN(sinceTime)) {
    console.error(`Invalid --since value: ${opts.since}`);
    return 1;
  }

  try {
    const logDirs = await resolveRollLogDirs(opts.cwd, opts.logDir);
    const files = await listJsonlFiles(logDirs);
    const runs: RunAggregate[] = [];

    for (const filePath of files) {
      const events = await readEvents(filePath);
      if (!events || events.length === 0) continue;

      const workflowStart = events.find(
        event =>
          event.type === 'workflow_start' &&
          typeof event.workflow_name === 'string' &&
          typeof event.ts === 'string'
      );
      if (!workflowStart?.workflow_name || !workflowStart.ts) continue;

      const startTime = Date.parse(workflowStart.ts);
      if (sinceTime !== undefined && (Number.isNaN(startTime) || startTime < sinceTime)) {
        continue;
      }

      let totalCostUsd = 0;
      let totalWallMs = 0;
      let totalTokensIn = 0;
      let totalTokensOut = 0;

      for (const event of events) {
        if (event.type !== 'node_complete') continue;
        totalCostUsd += event.cost_usd ?? 0;
        totalWallMs += event.duration_ms ?? 0;
        totalTokensIn += event.tokens?.input ?? 0;
        totalTokensOut += event.tokens?.output ?? 0;
      }

      runs.push({
        workflowName: workflowStart.workflow_name,
        ts: workflowStart.ts,
        totalCostUsd,
        totalWallMs,
        totalTokensIn,
        totalTokensOut,
      });
    }

    runs.sort((a, b) => b.ts.localeCompare(a.ts));
    const limitedRuns =
      opts.limit !== undefined && opts.limit >= 0 ? runs.slice(0, opts.limit) : runs;

    const grouped = new Map<string, RunAggregate[]>();
    for (const run of limitedRuns) {
      const existing = grouped.get(run.workflowName);
      if (existing) {
        existing.push(run);
      } else {
        grouped.set(run.workflowName, [run]);
      }
    }

    const groups: RollupGroup[] = [...grouped.entries()]
      .map(([workflowName, workflowRuns]) => {
        const wallTimes = workflowRuns.map(run => run.totalWallMs);
        const totalCostUsd = workflowRuns.reduce((sum, run) => sum + run.totalCostUsd, 0);
        const totalTokensIn = workflowRuns.reduce((sum, run) => sum + run.totalTokensIn, 0);
        const totalTokensOut = workflowRuns.reduce((sum, run) => sum + run.totalTokensOut, 0);

        return {
          workflow_name: workflowName,
          runs: workflowRuns.length,
          avg_cost_usd: workflowRuns.length === 0 ? 0 : totalCostUsd / workflowRuns.length,
          p50_wall_ms: computeNearestRank(wallTimes, 50),
          p95_wall_ms: computeNearestRank(wallTimes, 95),
          total_tokens_in: totalTokensIn,
          total_tokens_out: totalTokensOut,
        };
      })
      .sort((a, b) => a.workflow_name.localeCompare(b.workflow_name));

    printRollup(groups, opts.json);
    return 0;
  } catch (error) {
    const err = error as Error;
    console.error(`Failed to aggregate workflow costs: ${err.message}`);
    return 1;
  }
}
