// @effect-diagnostics nodeBuiltinImport:off -- the guard reads RAM size and signals host processes it found under the server.
import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ProcessRunner from "../processRunner.ts";

const CRITICAL_PRESSURE_LEVEL = 4;
const MIN_VICTIM_BYTES = 1024 ** 3;
const MIN_SERVER_TREE_SHARE = 0.25;
const CHECK_INTERVAL = "2 seconds";
const RECLAIM_WAIT = "10 seconds";
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu", "pwsh"]);
const UNIT_BYTES: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly bytes: number;
  readonly command: string;
}

export interface Victim {
  readonly pid: number;
  readonly command: string;
  readonly bytes: number;
  readonly pids: ReadonlyArray<number>;
}

/** Parses `top -l 1 -stats pid,ppid,mem,command`. MEM is the footprint, compressed pages included. */
export function parseTopProcesses(text: string): Array<ProcessEntry> {
  const entries: Array<ProcessEntry> = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)([BKMGT])[+-]?\s+(.*)$/.exec(line);
    if (match === null) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      bytes: Number(match[3]) * (UNIT_BYTES[match[4]!] ?? 1),
      command: match[5]!.trim(),
    });
  }
  return entries;
}

const isShell = (command: string) => SHELLS.has(command.replace(/^-/, ""));

/**
 * Victims are the outermost commands a shell under the server launched: a test
 * suite with its workers, say. Agents, their launchers, MCP servers, and the
 * preview browser are not started by a shell, so sessions survive and only see
 * a command fail. Nothing is killed unless the server's tree holds a real share
 * of RAM, so pressure from other apps never costs a session its command.
 */
export function pickVictim(
  entries: ReadonlyArray<ProcessEntry>,
  serverPid: number,
  totalMemoryBytes: number,
): Victim | undefined {
  const children = new Map<number, Array<ProcessEntry>>();
  for (const entry of entries) {
    if (entry.pid === entry.ppid) continue;
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }
  const collect = (root: ProcessEntry) => {
    const pids: Array<number> = [];
    let bytes = 0;
    const stack = [root];
    while (stack.length > 0) {
      const entry = stack.pop()!;
      pids.push(entry.pid);
      bytes += entry.bytes;
      stack.push(...(children.get(entry.pid) ?? []));
    }
    return { pids, bytes };
  };

  let serverTreeBytes = 0;
  let victim: Victim | undefined;
  const stack = (children.get(serverPid) ?? []).map((entry) => ({ entry, parentIsShell: false }));
  while (stack.length > 0) {
    const { entry, parentIsShell } = stack.pop()!;
    if (parentIsShell) {
      const tree = collect(entry);
      serverTreeBytes += tree.bytes;
      if (tree.bytes >= MIN_VICTIM_BYTES && (victim === undefined || tree.bytes > victim.bytes)) {
        victim = { pid: entry.pid, command: entry.command, ...tree };
      }
      continue;
    }
    serverTreeBytes += entry.bytes;
    const shell = isShell(entry.command);
    for (const child of children.get(entry.pid) ?? []) {
      stack.push({ entry: child, parentIsShell: shell });
    }
  }
  return serverTreeBytes >= totalMemoryBytes * MIN_SERVER_TREE_SHARE ? victim : undefined;
}

/**
 * macOS has no cgroups, so concurrent agent commands can push memory pressure
 * until the machine stalls. Linux caps agents with a systemd slice instead.
 */
const run = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const totalMemoryBytes = NodeOS.totalmem();
  const read = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: "30 seconds" }).pipe(
      Effect.option,
      Effect.map((result) =>
        result._tag === "Some" && result.value.code === 0 ? result.value.stdout : undefined,
      ),
    );
  const kill = (pid: number) => Effect.try(() => process.kill(pid, "SIGKILL")).pipe(Effect.ignore);

  const check = Effect.gen(function* () {
    const level = yield* read("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
    if (level === undefined || Number(level.trim()) < CRITICAL_PRESSURE_LEVEL) return;
    const top = yield* read("/usr/bin/top", ["-l", "1", "-stats", "pid,ppid,mem,command"]);
    if (top === undefined) return;
    const victim = pickVictim(parseTopProcesses(top), process.pid, totalMemoryBytes);
    if (victim === undefined) return;
    // The group also reaches workers forked after the snapshot.
    yield* kill(-victim.pid);
    yield* Effect.forEach(victim.pids, kill, { discard: true });
    yield* Effect.logWarning("Killed the largest agent command: memory pressure is critical", {
      pid: victim.pid,
      command: victim.command,
      bytes: victim.bytes,
      processes: victim.pids.length,
    });
    yield* Effect.sleep(RECLAIM_WAIT);
  });

  return yield* check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.asVoid);
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "darwin") yield* Effect.forkScoped(run);
  }),
);
