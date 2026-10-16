import { describe, expect, it } from "@effect/vitest";

import { parseTopProcesses, pickVictim } from "./memoryGuard.ts";

const TOP = `Processes: 612 total, 3 running, 609 sleeping, 3561 threads
PhysMem: 31G used (4096M wired, 9G compressor), 312M unused.

PID    PPID  MEM    COMMAND
100    1     300M   node
200    100   900M   codex
300    200   12M    zsh
301    300   1.5G+  node
302    301   2G-    node (vitest 1)
400    100   20M    zsh
401    400   800M   node
500    100   900M   claude
501    500   700M   bash
`;

describe("parseTopProcesses", () => {
  it("reads pid, parent, and footprint from top", () => {
    const entries = parseTopProcesses(TOP);
    expect(entries).toHaveLength(9);
    expect(entries[4]).toEqual({
      pid: 302,
      ppid: 301,
      bytes: 2 * 1024 ** 3,
      command: "node (vitest 1)",
    });
  });
});

describe("pickVictim", () => {
  it("kills the largest command tree an agent or terminal runs, not the agent", () => {
    const victim = pickVictim(parseTopProcesses(TOP), 100);
    expect(victim?.pid).toBe(300);
    expect([...(victim?.pids ?? [])].toSorted()).toEqual([300, 301, 302]);
  });

  it("leaves commands under a gigabyte alone", () => {
    expect(
      pickVictim(
        parseTopProcesses(TOP).filter((entry) => entry.pid < 301),
        100,
      ),
    ).toBe(undefined);
  });
});
