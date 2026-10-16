// @effect-diagnostics nodeBuiltinImport:off -- the guard signals host processes it found under the server.
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import * as ProcessRunner from "../processRunner.ts";

const CRITICAL_PRESSURE_LEVEL = 4;
const MIN_VICTIM_BYTES = 1024 ** 3;
const CHECK_INTERVAL = "2 seconds";
const RECLAIM_WAIT = "10 seconds";
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

/**
 * The server's children are agents and terminal shells. Their children are the
 * commands they run, such as a test suite and its workers. The largest of those
 * trees is the victim, so the session survives and only sees its command fail.
 */
export function pickVictim(
  entries: ReadonlyArray<ProcessEntry>,
  serverPid: number,
): Victim | undefined {
  const children = new Map<number, Array<ProcessEntry>>();
  for (const entry of entries) {
    if (entry.pid === entry.ppid) continue;
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }
  let victim: Victim | undefined;
  for (const owner of children.get(serverPid) ?? []) {
    for (const root of children.get(owner.pid) ?? []) {
      const pids: Array<number> = [];
      let bytes = 0;
      const stack = [root];
      while (stack.length > 0) {
        const entry = stack.pop()!;
        pids.push(entry.pid);
        bytes += entry.bytes;
        stack.push(...(children.get(entry.pid) ?? []));
      }
      if (bytes >= MIN_VICTIM_BYTES && (victim === undefined || bytes > victim.bytes)) {
        victim = { pid: root.pid, command: root.command, bytes, pids };
      }
    }
  }
  return victim;
}

/**
 * macOS has no cgroups, so concurrent agent commands can push memory pressure
 * until the machine stalls. Linux caps agents with a systemd slice instead.
 */
export const run = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const read = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: "10 seconds" }).pipe(
      Effect.option,
      Effect.map((result) =>
        result._tag === "Some" && result.value.code === 0 ? result.value.stdout : undefined,
      ),
    );

  const check = Effect.gen(function* () {
    const level = yield* read("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
    if (level === undefined || Number(level.trim()) < CRITICAL_PRESSURE_LEVEL) return;
    const top = yield* read("/usr/bin/top", ["-l", "1", "-stats", "pid,ppid,mem,command"]);
    if (top === undefined) return;
    const victim = pickVictim(parseTopProcesses(top), process.pid);
    if (victim === undefined) return;
    yield* Effect.logWarning("Killed the largest agent command: memory pressure is critical", {
      pid: victim.pid,
      command: victim.command,
      bytes: victim.bytes,
      processes: victim.pids.length,
    });
    yield* Effect.forEach(
      victim.pids,
      (pid) => Effect.try(() => process.kill(pid, "SIGKILL")).pipe(Effect.ignore),
      { discard: true },
    );
    yield* Effect.sleep(RECLAIM_WAIT);
  });

  return yield* check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.asVoid);
});
