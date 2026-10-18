import type { EnvironmentId, ProviderGetContextUsageResult, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronRightIcon } from "lucide-react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { threadEnvironment } from "../../state/threads";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

const USED_COLORS = ["bg-blue-500", "bg-orange-500", "bg-emerald-500", "bg-amber-500"];
const KIND_ORDER = { used: 0, buffer: 1, free: 2, deferred: 3 } as const;

type Category = ProviderGetContextUsageResult["categories"][number];

function categoryColor(category: Category, usedIndex: number): string {
  if (category.kind === "free") return "bg-muted";
  if (category.kind === "used") return USED_COLORS[usedIndex] ?? "bg-muted-foreground/60";
  return "bg-muted-foreground/30";
}

function formatShare(tokens: number, maxTokens: number): string {
  return maxTokens > 0 ? `${((tokens / maxTokens) * 100).toFixed(1)}%` : "—";
}

function ItemGroup(props: { title: string; items: ProviderGetContextUsageResult["mcpTools"] }) {
  if (props.items.length === 0) return null;
  const total = props.items.reduce((sum, item) => sum + item.tokens, 0);
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 py-0.5 text-left">
        <ChevronRightIcon className="size-3 transition-transform group-data-panel-open:rotate-90" />
        <span className="flex-1">{props.title}</span>
        <span className="tabular-nums">{formatContextWindowTokens(total)}</span>
        <span className="w-10 text-right tabular-nums">{props.items.length}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="max-h-40 overflow-y-auto ps-4.5">
          {props.items
            .toSorted((a, b) => b.tokens - a.tokens)
            .map((item) => (
              <div key={item.name} className="flex gap-2 py-0.5">
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="tabular-nums">{formatContextWindowTokens(item.tokens)}</span>
              </div>
            ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function ThreadContextBreakdown(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const result = useAtomValue(
    threadEnvironment.contextUsage({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );

  if (result._tag === "Initial") {
    return <div className="text-muted-foreground text-xs">Loading context breakdown…</div>;
  }
  if (result._tag === "Failure") {
    return (
      <div className="text-pretty text-muted-foreground text-xs">
        The breakdown is available while a Claude session is running in this thread.
      </div>
    );
  }
  const usage = result.value;

  let usedIndex = 0;
  const rows = usage.categories
    .toSorted((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.tokens - a.tokens)
    .map((category) => ({
      category,
      color: categoryColor(category, category.kind === "used" ? usedIndex++ : 0),
    }));

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Context window</span>
        <span className="text-muted-foreground tabular-nums">
          {formatContextWindowTokens(usage.totalTokens)} /{" "}
          {formatContextWindowTokens(usage.maxTokens)} (
          {formatShare(usage.totalTokens, usage.maxTokens)})
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        {rows
          .filter(({ category }) => category.kind === "used" || category.kind === "buffer")
          .map(({ category, color }) => (
            <div
              key={category.name}
              className={color}
              style={{ width: formatShare(category.tokens, usage.maxTokens) }}
            />
          ))}
      </div>
      <div className="flex flex-col">
        {rows.map(({ category, color }) => (
          <div key={category.name} className="flex items-center gap-2 py-0.5">
            <span className={cn("size-2.5 shrink-0 rounded-sm", color)} />
            <span className="flex-1">{category.name}</span>
            <span className="text-muted-foreground tabular-nums">
              {formatContextWindowTokens(category.tokens)}
            </span>
            <span className="w-10 text-right tabular-nums">
              {category.kind === "deferred" ? "—" : formatShare(category.tokens, usage.maxTokens)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-col text-muted-foreground">
        <ItemGroup title="MCP tools" items={usage.mcpTools} />
        <ItemGroup title="Memory files" items={usage.memoryFiles} />
        <ItemGroup title="Custom agents" items={usage.agents} />
      </div>
    </div>
  );
}
