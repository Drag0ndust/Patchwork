/**
 * The order a workflow runs in: one traversal of a Patchwork document, shared by
 * everything that has to *follow* the graph.
 *
 * Slice 1 needed nothing more than "walk the chain from Input to Output", and the
 * compiler kept that walk to itself. A `conditional` node makes the shape a tree of
 * segments instead of a list: at a conditional the workflow fans out into one
 * labelled branch per way out, and the branches re-converge on the first node all of
 * them reach. The plan is that structure — a flat list of segments where a branch is
 * itself a segment holding sub-lists — so a consumer never has to re-derive where a
 * branch ends.
 *
 * Two consumers, deliberately the same traversal:
 *
 * - the **Graph Compiler**, which renders the segments as the umbrella's numbered
 *   steps, and
 * - **`validateGraph`**, which asks the plan whether the graph can be followed at
 *   all (its [`WorkflowPlan.problems`]) rather than re-deriving a second, possibly
 *   disagreeing notion of a well-formed branch.
 *
 * This module imports the schema for **types only**, so the mutual import with
 * `graph-document` (which calls `planWorkflow`) is not a runtime cycle: neither
 * module touches the other's bindings while either is still evaluating. The one
 * exception is [`branchesOf`], a tolerant accessor that belongs with the schema it
 * reads and is called only from inside functions here.
 *
 * Nothing here throws, for any document, however malformed. A cycle, a dangling branch,
 * a node with two ways out, an unreachable node: each is `validateGraph`'s to reject, and
 * the plan meanwhile stays total — it reports what it cannot follow, drops no
 * node, and terminates. The bound on *that* promise is the graph, not the machine: no
 * traversal here recurses and none spreads graph-sized data into an argument list, so
 * depth and width are limited by memory rather than by the call stack.
 *
 * The promise stops at the plan. **`compile` is not total on an arbitrary document** and
 * this module cannot make it so: the umbrella it renders indents every line of a branch
 * one level further, so a document nested thousands deep produces a string longer than the
 * runtime can hold (`RangeError: Invalid string length`) no matter how the plan is walked.
 * That is why `validateGraph` bounds the size of a document *before* planning it and its
 * nesting depth from the plan, and why the export path validates first: the guarantee a
 * caller of `compile` may rely on is "a document `validateGraph` accepts compiles", not
 * "any document compiles".
 */

import { branchesOf } from "./graph-document";
import type {
  Branch,
  GraphEdge,
  GraphNode,
  PatchworkDocument,
} from "./graph-document";

/** One thing the workflow does, in order. */
export type FlowSegment =
  | { kind: "step"; node: GraphNode }
  | { kind: "branch"; node: GraphNode; branches: PlannedBranch[] };

/** One labelled branch of a conditional, and the segments it runs. */
export interface PlannedBranch {
  branch: Branch;
  /**
   * The branch's own steps, up to (but not including) the node where every branch
   * of this conditional converges. Empty when the branch goes straight there.
   */
  segments: FlowSegment[];
}

export interface WorkflowPlan {
  segments: FlowSegment[];
  /**
   * Structural reasons the graph cannot be followed as drawn, phrased for the user.
   * Surfaced by `validateGraph`; `compile` ignores them and emits its best reading,
   * because the export path refuses before it compiles.
   */
  problems: string[];
}

/**
 * How the plan is asked for. Everything here has a default; the options exist so a test
 * can reach a path that is otherwise only reachable at a size no test suite should build.
 */
export interface PlanOptions {
  /**
   * The ceiling on the transitive closure, in bytes — see [`MAX_CLOSURE_BYTES`],
   * which is the default. Lowering it forces the sweep fallback, which is how the two
   * reachability implementations are checked against each other on a small document
   * instead of on the ~16,000-node one where the boundary really sits.
   */
  maxClosureBytes?: number;
}

/**
 * One piece of the walk.
 *
 * A `walk` follows edges from `start`, appending to `collect`, and stops *before* any node
 * whose scope is currently open. `enter`/`leave` open and close such a scope, and the
 * three together make the traversal an explicit depth-first search: at a conditional the
 * plan queues `enter(join)`, one `walk` per branch, `leave(join)`, then the parent's own
 * `walk` continuing at the join — in that order, so a branch body always sees
 * exactly the joins of the conditionals enclosing it.
 *
 * That is what replaced a per-branch `new Set([...inherited, join])`. Copying the inherited
 * stops at every level cost O(depth) per level, so planning a deeply nested document was
 * quadratic in its depth: 8,000 levels took 2.8 s and 12,000 took 40 s, on the renderer's
 * main thread, which is the frozen-window defect class this codebase already treats as a
 * bug (see `collapseLineBreakRuns`). A scope counter is O(1) both to open and to test.
 *
 * Jobs rather than recursion, and `collect` being an array that is already in place, is
 * also what makes nesting free of the call stack: a branch's segments are appended to a
 * list the parent has already positioned, so a document nested arbitrarily deep cannot
 * overflow. `validateGraph` must return errors, never throw, and it walks whatever the
 * user drew.
 */
type WalkJob =
  | { kind: "walk"; collect: FlowSegment[]; start: string }
  | { kind: "enter"; id: string }
  | { kind: "leave"; id: string };

/** Plan the order a document runs in. Pure; never throws. */
export function planWorkflow(
  doc: PatchworkDocument,
  options: PlanOptions = {},
): WorkflowPlan {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of doc.edges) {
    // Edges with a missing endpoint are `validateGraph`'s to report; following one
    // would mean walking to a node that does not exist.
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const list = outgoing.get(edge.source);
    if (list) list.push(edge);
    else outgoing.set(edge.source, [edge]);
  }

  const segments: FlowSegment[] = [];
  const problems: string[] = [];
  const visited = new Set<string>();
  // Only a document that actually branches pays for the convergence index.
  let index: ConvergenceIndex | undefined;
  const indexOf = () => (index ??= buildConvergenceIndex(doc, outgoing, options));

  /**
   * The joins whose scopes are open, as a multiset: two nested conditionals can converge
   * on the same node, and closing the inner scope must not reopen the outer one.
   */
  const openScopes = new Map<string, number>();
  const openScope = (id: string, by: number) => {
    const depth = (openScopes.get(id) ?? 0) + by;
    if (depth > 0) openScopes.set(id, depth);
    else openScopes.delete(id);
  };

  const input = doc.nodes.find((n) => n.type === "input");
  const jobs: WalkJob[] =
    input === undefined ? [] : [{ kind: "walk", collect: segments, start: input.id }];

  while (jobs.length > 0) {
    const job = jobs.pop() as WalkJob;
    if (job.kind === "enter") {
      openScope(job.id, 1);
      continue;
    }
    if (job.kind === "leave") {
      openScope(job.id, -1);
      continue;
    }

    let cursor: string | undefined = job.start;
    while (cursor !== undefined && !openScopes.has(cursor)) {
      const node = byId.get(cursor);
      if (node === undefined) break;
      if (visited.has(cursor)) {
        // Either a cycle or a branch that rejoined another one early. Both mean the
        // same thing for the emitted prose — this node would be instructed
        // twice — and stopping here is what keeps the walk finite.
        problems.push(
          `Node '${cursor}' is reached more than once when the workflow is followed; a Conditional's branches must not rejoin before the point where all of them converge`,
        );
        break;
      }
      visited.add(cursor);

      const edges: GraphEdge[] = outgoing.get(cursor) ?? [];
      if (node.type !== "conditional") {
        job.collect.push({ kind: "step", node });
        // More than one way out of a non-conditional node is a validation error;
        // taking the first keeps the plan total instead of guessing at a merge.
        cursor = edges[0]?.target;
        continue;
      }

      // The node each branch leaves by. First edge wins for a branch wired twice
      // (also a validation error), so the plan is a function of document order.
      const heads = new Map<string, string>();
      for (const edge of edges) {
        if (edge.branch === undefined) continue;
        if (!heads.has(edge.branch)) heads.set(edge.branch, edge.target);
      }

      const join = convergence([...new Set(heads.values())], indexOf());
      const planned: PlannedBranch[] = branchesOf(node).map((branch) => ({
        branch,
        segments: [],
      }));
      job.collect.push({ kind: "branch", node, branches: planned });

      // Queued in reading order and processed in it: the join's scope opens, every branch
      // body is walked inside it, the scope closes, and only then does this walk continue
      // at the join. Undefined means the branches never converge (a graph validation
      // rejects), in which case each body simply runs to its end and this walk stops.
      const queued: WalkJob[] = [];
      if (join !== undefined) queued.push({ kind: "enter", id: join });
      for (const entry of planned) {
        // `entry.branch?.id`, because a hand-built document can hold anything in that array and
        // this module's promise is that nothing here throws for any document. A branch that is
        // not an object wires to nothing, which is what an unwired branch already does.
        const branchId = entry.branch?.id;
        const head = branchId === undefined ? undefined : heads.get(branchId);
        // An unwired branch contributes no steps rather than no branch: the umbrella
        // still shows the choice the user drew, and validation refuses the export.
        if (head === undefined) continue;
        queued.push({ kind: "walk", collect: entry.segments, start: head });
      }
      if (join !== undefined) {
        queued.push({ kind: "leave", id: join });
        queued.push({ kind: "walk", collect: job.collect, start: join });
      }
      for (let at = queued.length - 1; at >= 0; at -= 1) jobs.push(queued[at]);
      break;
    }
  }

  // Anything the walk never reached is appended in document order, so a malformed
  // graph still exports every step it holds instead of losing some of them
  // invisibly. `validateGraph` reports each as unconnected.
  for (const node of doc.nodes) {
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    // A conditional is a branch segment wherever it sits, even unreached: the segment
    // kind is what a consumer decides how to render from, so a conditional appearing
    // as a plain step would be rendered as an instruction it does not have.
    segments.push(
      node.type === "conditional"
        ? {
            kind: "branch",
            node,
            branches: branchesOf(node).map((branch) => ({ branch, segments: [] })),
          }
        : { kind: "step", node },
    );
  }

  return { segments, problems };
}

/**
 * Every node the plan visits, in the order it is instructed.
 *
 * Iterative, like everything else here: recursion made this the one traversal that
 * could still fail on a document `validateGraph` accepted — `compile` *and*
 * `vendorErrors` (the export's own precondition check) both go through it, so a deeply
 * nested workflow ended an export with `RangeError: Maximum call stack size exceeded`
 * rather than a bundle.
 */
export function plannedNodes(plan: WorkflowPlan): GraphNode[] {
  const nodes: GraphNode[] = [];
  // Pre-order: a segment, then whatever its branches hold. The stack is filled in
  // reverse so popping yields reading order.
  const pending: FlowSegment[] = [];
  pushReversed(pending, plan.segments);

  while (pending.length > 0) {
    const segment = pending.pop() as FlowSegment;
    nodes.push(segment.node);
    if (segment.kind !== "branch") continue;
    // Branch bodies, last branch first, so the first branch is popped next.
    for (let at = segment.branches.length - 1; at >= 0; at -= 1) {
      pushReversed(pending, segment.branches[at].segments);
    }
  }
  return nodes;
}

/**
 * Push `segments` so that a `pop()`-driven loop sees them front to back.
 *
 * A loop, not `push(...segments)`: a conditional may have thousands of branches and a
 * branch thousands of steps, and spreading them passes each as an argument — which is
 * the same argument-stack overflow the umbrella's frontmatter emitter documents.
 */
function pushReversed(stack: FlowSegment[], segments: readonly FlowSegment[]): void {
  for (let at = segments.length - 1; at >= 0; at -= 1) stack.push(segments[at]);
}

/**
 * How deeply the plan's branches nest — 0 for a chain, 1 for one conditional, 2 for a
 * conditional inside a branch of another.
 *
 * Asked by `validateGraph`, because the depth is what the emitted umbrella pays for:
 * every level adds an indentation level to every line below it, so the file grows with
 * the square of the nesting while the reader's job grows with 2^depth open choices.
 */
export function nestingDepth(plan: WorkflowPlan): number {
  let deepest = 0;
  const pending: Array<{ segments: readonly FlowSegment[]; depth: number }> = [
    { segments: plan.segments, depth: 0 },
  ];
  while (pending.length > 0) {
    const { segments, depth } = pending.pop() as {
      segments: readonly FlowSegment[];
      depth: number;
    };
    for (const segment of segments) {
      if (segment.kind !== "branch") continue;
      if (depth + 1 > deepest) deepest = depth + 1;
      for (const entry of segment.branches) {
        pending.push({ segments: entry.segments, depth: depth + 1 });
      }
    }
  }
  return deepest;
}

/**
 * What a convergence point is looked up against: the topological order, and a way to ask
 * "does this branch head reach that node?".
 *
 * Built once per plan, and only for a document that actually branches. It exists because
 * the obvious spelling — sweep the graph from each branch head, intersect the
 * results — re-walks the whole reachable graph once per branch per
 * conditional, which is quadratic: a chain of 6,000 two-branch conditionals took **8.8
 * seconds** to plan, and an export plans three times (`validateGraph`, `vendorErrors`,
 * `compile`) on the renderer's main thread. That is the same defect class as the quadratic
 * collapse [`collapseLineBreakRuns`] documents fixing — a frozen window, not
 * a slow function.
 */
interface ConvergenceIndex {
  /** Topological position per node id; see [`topologicalIndex`]. */
  order: Map<string, number>;
  /** Every node id ordered by that position, so candidates can be scanned in order. */
  byTopo: string[];
  /**
   * True when every node has a real topological position, i.e. the document is acyclic.
   *
   * The scan's starting point depends on it: see [`convergence`].
   */
  acyclic: boolean;
  /**
   * Reachability for one conditional's heads, prepared once per conditional.
   *
   * Prepared per call rather than answered per question because the two implementations
   * pay in different places: the closure answers in constant time and ignores this, while
   * the fallback has to sweep, and sweeping *per candidate* would be cubic.
   */
  prepare: (heads: readonly string[]) => (head: string, candidate: string) => boolean;
}

/**
 * How much memory the transitive closure may take before it is not worth it.
 *
 * The closure is one bit per node pair — `n²/8` bytes — which is 64× smaller than a
 * `Set` per node and turns every reachability question into one array read. 32 MB covers a
 * document of some 16,000 nodes — twice `MAX_WORKFLOW_NODES`, so a document
 * `validateGraph` accepts is always on this path. Beyond the ceiling, correctness is kept and
 * speed is given up: a bigger document sweeps per conditional, as this used to, rather than
 * risking an allocation that fails. Only a caller that skipped validation gets there.
 */
const MAX_CLOSURE_BYTES = 32 * 1024 * 1024;

function buildConvergenceIndex(
  doc: PatchworkDocument,
  outgoing: ReadonlyMap<string, GraphEdge[]>,
  options: PlanOptions,
): ConvergenceIndex {
  const order = topologicalIndex(doc, outgoing);
  const total = doc.nodes.length;
  // Every node, in topological order. `topologicalIndex` gives a position to all of them
  // — nodes on a cycle are parked after the sorted ones — so
  // the scan is complete even for a document `validateGraph` will refuse.
  const byTopo = doc.nodes
    .map((node) => node.id)
    .sort(
      (left, right) =>
        (order.get(left) ?? total) - (order.get(right) ?? total),
    );
  const acyclic = doc.nodes.every((node) => (order.get(node.id) ?? total) < total);

  const words = Math.ceil(total / 32) || 1;
  const ceiling = options.maxClosureBytes ?? MAX_CLOSURE_BYTES;
  if (!acyclic || total * words * 4 > ceiling) {
    // Cyclic (the closure's reverse-topological fill would be wrong) or too large to hold.
    // One sweep per head per conditional, which is what the cost of this path is bounded
    // by — never one per candidate.
    return {
      order,
      byTopo,
      acyclic,
      prepare: (heads) => {
        const reachable = new Map<string, Set<string>>();
        for (const head of heads) {
          if (!reachable.has(head)) reachable.set(head, reachableFrom(head, outgoing));
        }
        return (head, candidate) => reachable.get(head)?.has(candidate) === true;
      },
    };
  }

  // One row of bits per node, indexed by topological position, filled in reverse
  // topological order: in a DAG every successor sits at a higher position, so its row is
  // already complete when it is folded in. Linear in nodes × words.
  //
  // `at >>> 5` picks the word and `at & 31` the bit inside it. Only the first of those is
  // load-bearing: JavaScript already takes a shift count modulo 32, so `1 << (at & 31)` and
  // `1 << at` are the same instruction. The mask is spelled out because the *word* index is
  // not automatic, and a reader checking this arithmetic should see both halves of it.
  const closure = new Uint32Array(total * words);
  for (let at = total - 1; at >= 0; at -= 1) {
    const row = at * words;
    closure[row + (at >>> 5)] |= 1 << (at & 31);
    for (const edge of outgoing.get(byTopo[at]) ?? []) {
      const successor = (order.get(edge.target) ?? 0) * words;
      for (let word = 0; word < words; word += 1) {
        closure[row + word] |= closure[successor + word];
      }
    }
  }
  const reaches = (from: string, to: string): boolean => {
    const row = order.get(from);
    const bit = order.get(to);
    if (row === undefined || bit === undefined) return false;
    return (closure[row * words + (bit >>> 5)] & (1 << (bit & 31))) !== 0;
  };

  return { order, byTopo, acyclic, prepare: () => reaches };
}

/**
 * The node where every branch of a conditional comes back together: the earliest node, in
 * topological order, that all of them reach.
 *
 * "Earliest in topological order" is what makes this the point the branches *converge*
 * rather than merely some node they share — a later common node is reached
 * only by passing through this one. Branch heads count as reachable from themselves, so a
 * branch wired directly to the convergence point (or into another branch) is handled by the
 * same rule instead of a special case.
 *
 * The rule is unchanged from the first spelling of it; only the way it is asked is. Scanning
 * topological order and stopping at the first node every head reaches is the same answer as
 * intersecting the heads' reachable sets and taking the earliest, without materializing the
 * sets.
 *
 * In an **acyclic** document the scan may start at the *last* of the heads, because a node
 * every branch reaches cannot come before one of them, and in a properly nested graph it
 * then stops at the very next candidate. That shortcut is **not** valid once a cycle is
 * present: `topologicalIndex` has no position for a node on a cycle and parks it after every
 * sorted one, so a node every head reaches can sit before the last head and the scan would
 * walk straight past it, answering something the documented rule does not. A cyclic document
 * is one `validateGraph` refuses — and loops are a planned slice — so the
 * shortcut is skipped rather than kept with a caveat: the two spellings of this rule have to
 * agree on every input, not only on the ones that are currently legal.
 *
 * Undefined when the branches have no node in common at all. That needs a graph
 * `validateGraph` already refuses (one Output node, every node leading somewhere, no cycles
 * ⇒ every branch reaches the Output), so it is a floor for hand-edited
 * documents rather than a case the UI can produce.
 */
function convergence(
  heads: readonly string[],
  index: ConvergenceIndex,
): string | undefined {
  if (heads.length === 0) return undefined;

  let from = 0;
  if (index.acyclic) {
    for (const head of heads) {
      const at = index.order.get(head);
      if (at !== undefined && at > from) from = at;
    }
  }

  const reaches = index.prepare(heads);
  for (let at = from; at < index.byTopo.length; at += 1) {
    const candidate = index.byTopo[at];
    let reachedByAll = true;
    for (const head of heads) {
      if (reaches(head, candidate)) continue;
      reachedByAll = false;
      break;
    }
    if (reachedByAll) return candidate;
  }
  return undefined;
}

/**
 * Every node reachable from `start`, including `start`. Cycle-safe, iterative.
 *
 * The fallback for a document the transitive closure will not be built for — cyclic, or
 * larger than [`MAX_CLOSURE_BYTES`] allows. Correct but re-swept per question, which is
 * what made the plan quadratic when it was the only implementation.
 */
function reachableFrom(
  start: string,
  outgoing: ReadonlyMap<string, GraphEdge[]>,
): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const edge of outgoing.get(id) ?? []) {
      if (seen.has(edge.target)) continue;
      seen.add(edge.target);
      stack.push(edge.target);
    }
  }
  return seen;
}

/**
 * A topological position per node, by Kahn's algorithm over the whole document.
 *
 * Iterative and linear, and it takes candidates in document order, so the index — and
 * therefore every convergence point derived from it — is deterministic for a given
 * document rather than dependent on iteration accident.
 *
 * Nodes that remain after the sweep are on (or downstream of) a cycle and have no
 * topological position; they are ordered *after* every sorted node, by their position
 * in the document. `validateGraph` rejects the cycle, and the compiler still needs an
 * order to emit.
 */
function topologicalIndex(
  doc: PatchworkDocument,
  outgoing: ReadonlyMap<string, GraphEdge[]>,
): Map<string, number> {
  const remaining = new Map<string, number>();
  for (const node of doc.nodes) remaining.set(node.id, 0);
  for (const edges of outgoing.values()) {
    for (const edge of edges) {
      remaining.set(edge.target, (remaining.get(edge.target) ?? 0) + 1);
    }
  }

  const index = new Map<string, number>();
  const ready = doc.nodes.filter((n) => remaining.get(n.id) === 0).map((n) => n.id);
  // A cursor, not `shift()`: a 20,000-node chain would otherwise re-copy the queue
  // on every step.
  for (let at = 0; at < ready.length; at += 1) {
    const id = ready[at];
    index.set(id, index.size);
    for (const edge of outgoing.get(id) ?? []) {
      const left = (remaining.get(edge.target) ?? 0) - 1;
      remaining.set(edge.target, left);
      if (left === 0) ready.push(edge.target);
    }
  }

  doc.nodes.forEach((node, at) => {
    if (!index.has(node.id)) index.set(node.id, doc.nodes.length + at);
  });
  return index;
}
