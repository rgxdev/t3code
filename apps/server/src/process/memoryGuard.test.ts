import { describe, expect, it } from "@effect/vitest";

import { parseTopProcesses, pickVictim } from "./memoryGuard.ts";

const GiB = 1024 ** 3;

const TOP = `Processes: 612 total, 3 running, 609 sleeping, 3561 threads
PhysMem: 31G used (4096M wired, 9G compressor), 312M unused.

PID    PPID  MEM    COMMAND
100    1     300M   node
200    100   20M    node
210    200   3G     codex
300    210   12M    zsh
301    300   1.5G+  node
302    301   2G-    node
303    302   10M    sh
304    303   600M   node
310    210   2G     python3.12
400    100   20M    -zsh
401    400   1200M  node
500    100   900M   chrome-headless-
501    500   4G     chrome-headless-
`;

const entries = parseTopProcesses(TOP);
const sorted = (pids: ReadonlyArray<number> | undefined) => [...(pids ?? [])].toSorted();

describe("parseTopProcesses", () => {
  it("reads pid, parent, and footprint from top", () => {
    expect(entries).toHaveLength(13);
    expect(entries[5]).toEqual({ pid: 302, ppid: 301, bytes: 2 * GiB, command: "node" });
  });
});

describe("pickVictim", () => {
  it("kills the largest command a shell started, with everything under it", () => {
    const victim = pickVictim(entries, 100, 32 * GiB);
    expect(victim?.pid).toBe(301);
    expect(sorted(victim?.pids)).toEqual([301, 302, 303, 304]);
  });

  it("never picks agents, their launchers, MCP servers, or the preview browser", () => {
    const victim = pickVictim(
      entries.filter((entry) => entry.ppid !== 300),
      100,
      32 * GiB,
    );
    expect(victim?.pid).toBe(401);
  });

  it("leaves commands under a gigabyte alone", () => {
    const small = entries.filter((entry) => entry.ppid !== 300 && entry.ppid !== 400);
    expect(pickVictim(small, 100, 32 * GiB)).toBe(undefined);
  });

  it("does nothing when the server's processes hold little of RAM", () => {
    expect(pickVictim(entries, 100, 128 * GiB)).toBe(undefined);
  });
});
