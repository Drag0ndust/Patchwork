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
 * Slice 7 adds the other fan-out: a **plain split**, where every path is followed rather
 * than one of them. It needs no segment kind — the paths are appended to the list the
 * splitting node sits in, in the order they were drawn, and the walk resumes where they
 * converge — but it shares the conditional's scoping, which is what stops a path *before*
 * the convergence point so the merge is instructed once (see [`pushWalks`]).
 *
 * Slice 6 closes the shape: a workflow may **loop**. A `conditional` whose branch arrives
 * back at a node the walk is already inside is a **loop gate**, and that branch is a
 * loop-back ([`loopBacks`]). A loop-back is planned rather than walked — its steps are the
 * ones already between its target and its gate — so the plan stays a finite, acyclic
 * structure while carrying where the next pass restarts ([`PlannedBranch.loopBackTo`]).
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
 * `graph-document` (which calls `planWorkflow` and [`fanInInputs`]) is not a runtime
 * cycle: neither module touches the other's bindings while either is still evaluating.
 * The two exceptions are [`branchesOf`] and `inputLabelOf` — tolerant accessors that
 * belong with the schema they read, and are called only from inside functions here.
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

import { branchesOf, inputLabelOf } from "./graph-document";
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
  /**
   * The node the next pass restarts at, when this branch **loops back** — the target
   * of the edge that closes the cycle (see [`loopBacks`]).
   *
   * A looping branch has no `segments` of its own, deliberately: the steps it runs are
   * the ones already planned between its target and this gate, and planning them twice
   * would instruct them twice. What it carries instead is where to go back to, which is
   * the one thing a reader of the plan cannot derive from the segment list.
   */
  loopBackTo?: GraphNode;
}

/**
 * One loop-back: the branch edge that closes a cycle, the `conditional` it leaves — the
 * **loop gate** — and the node the next pass restarts at.
 *
 * The gate is what makes a cycle followable rather than endless: it is the point at which
 * the workflow asks whether to go round again, and it is the node that carries the
 * max-iteration guard the exported control scaffold enforces (ADR-0006).
 */
export interface LoopBack {
  edge: GraphEdge;
  /** The `conditional` whose branch loops — the loop gate. */
  gate: GraphNode;
  /** Where the next pass restarts. */
  target: GraphNode;
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

/** One path out of a fan-out: where it starts, and the list its steps belong to. */
interface WalkBody {
  collect: FlowSegment[];
  start: string;
}

/**
 * Queue the paths a node fans out into, and the walk that continues past them.
 *
 * One helper for both fan-outs, because the *scoping* is the whole of what makes a
 * fan-out followable and it is identical for the two: the join's scope opens, every
 * path is walked inside it — so each stops before the convergence point instead of
 * instructing it — the scope closes, and only then does the enclosing walk resume
 * there. The two differ solely in where each path's steps are collected: a
 * conditional's into its own branch's list (only one of them runs), a plain split's
 * into the list it sits in (all of them run).
 *
 * Queued in reading order and processed in it. An undefined `join` means the paths
 * never converge — a graph `validateGraph` refuses — in which case each path simply
 * runs to its end and the enclosing walk stops.
 */
function pushWalks(
  jobs: WalkJob[],
  bodies: readonly WalkBody[],
  join: string | undefined,
  after: FlowSegment[],
): void {
  const queued: WalkJob[] = [];
  if (join !== undefined) queued.push({ kind: "enter", id: join });
  for (const body of bodies) {
    queued.push({ kind: "walk", collect: body.collect, start: body.start });
  }
  if (join !== undefined) {
    queued.push({ kind: "leave", id: join });
    queued.push({ kind: "walk", collect: after, start: join });
  }
  // Reversed rather than spread, like every other push here: a conditional may carry
  // thousands of branches, and `push(...queued)` passes each as an argument.
  for (let at = queued.length - 1; at >= 0; at -= 1) jobs.push(queued[at]);
}

/**
 * Every **loop-back** edge in the document, keyed by edge id.
 *
 * A loop-back is an edge that leaves a `conditional` on one of its branches and arrives at
 * a node the walk is **currently inside** — the node it came from, or one it came through.
 * Taking that branch is what going round again means, and the `conditional` it leaves is
 * the **loop gate**: the point at which the workflow asks whether to run the body once
 * more, and the node that carries the max-iteration guard the exported control scaffold
 * enforces (ADR-0006).
 *
 * Everything else about loops is defined in terms of this one set. [`planWorkflow`] walks
 * the graph with these edges taken out — which is what makes the walk finite and every
 * other traversal here a DAG traversal again — `validateGraph` refuses a cycle that *no*
 * such edge breaks, and the Graph Compiler emits the guard that bounds the passes.
 *
 * **"Already inside", not "points backwards" and not "sits on a cycle".** The test is
 * whether the target is on the depth-first path being walked when the edge is reached,
 * which is precisely the condition under which walking it would instruct a step a second
 * time. Neither cheaper rule says that:
 *
 * - *points backwards* is about the drawing, and a workflow's node list has no order the
 *   user maintains;
 * - *sits on a cycle* (both endpoints in one strongly connected component) also catches
 *   the branch that **enters** the loop from outside. `assess -> gate`, `gate --b--> B`,
 *   `B -> assess` is one component, so that rule called `gate --b--> B` the loop-back,
 *   dropped it from the walk, and left `B` unreachable — a step the user drew, silently
 *   outside their workflow.
 *
 * The depth-first search runs from the Input node and then from anything it did not
 * reach, taking nodes and edges in document order, so the answer is a function of the
 * document rather than of iteration accident. Where a cycle carries two gate branches that
 * could each be read as its loop-back, the first one the search meets is the one — the same
 * "first edge wins" rule the walk already applies to a branch wired twice.
 *
 * That is a **tie-break, not a judgement**, and the classification is order-stable for every
 * document: asked twice, this answers the same, and two documents that differ only in which
 * edge leads into the cycle are two different workflows — the guard is then owed by a
 * different gate — rather than one workflow read two ways.
 *
 * Iterative, and total: nothing here throws for any document, and no chain is too deep.
 */
export function loopBacks(doc: PatchworkDocument): Map<string, LoopBack> {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of doc.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const list = outgoing.get(edge.source);
    if (list) list.push(edge);
    else outgoing.set(edge.source, [edge]);
  }

  const found = new Map<string, LoopBack>();
  // On the current depth-first path — the colouring `validateGraph`'s own cycle check uses,
  // in the one place that now decides what a cycle *means*.
  const onPath = new Set<string>();
  const seen = new Set<string>();

  const input = doc.nodes.find((node) => node.type === "input");
  // The Input first, so the search starts where the workflow does; then anything it did not
  // reach, in document order, so a cycle off to one side is classified too.
  const starts = input === undefined ? doc.nodes : [input, ...doc.nodes];
  for (const start of starts) {
    if (seen.has(start.id)) continue;
    seen.add(start.id);
    onPath.add(start.id);
    const frames: Array<{ id: string; next: number }> = [{ id: start.id, next: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const edges = outgoing.get(frame.id) ?? [];
      if (frame.next >= edges.length) {
        onPath.delete(frame.id);
        frames.pop();
        continue;
      }
      const edge = edges[frame.next];
      frame.next += 1;
      if (onPath.has(edge.target)) {
        const gate = byId.get(edge.source) as GraphNode;
        const target = byId.get(edge.target) as GraphNode;
        // Only a *branch* of a conditional loops. Any other edge that closes a cycle is a
        // cycle with nothing to decide whether it runs again — the one `validateGraph`
        // refuses, and the one this deliberately does not rescue.
        if (
          gate.type === "conditional" &&
          edge.branch !== undefined &&
          edge.branch !== "" &&
          !found.has(edge.id)
        ) {
          found.set(edge.id, { edge, gate, target });
        }
        continue;
      }
      if (seen.has(edge.target)) continue;
      seen.add(edge.target);
      onPath.add(edge.target);
      frames.push({ id: edge.target, next: 0 });
    }
  }
  return found;
}

/** Plan the order a document runs in. Pure; never throws. */
export function planWorkflow(
  doc: PatchworkDocument,
  options: PlanOptions = {},
): WorkflowPlan {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  // The loop-backs, indexed by the gate and branch they leave by, so the walk can ask the
  // question it has at hand ("does *this* branch loop?") rather than re-deriving the rule.
  const loops = loopBacks(doc);
  const looping = new Map<string, Map<string, LoopBack>>();
  for (const loop of loops.values()) {
    const branches = looping.get(loop.gate.id) ?? new Map<string, LoopBack>();
    branches.set(loop.edge.branch as string, loop);
    looping.set(loop.gate.id, branches);
  }

  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of doc.edges) {
    // Edges with a missing endpoint are `validateGraph`'s to report; following one
    // would mean walking to a node that does not exist.
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    // A loop-back is followed by *going round again*, not by walking on: its steps are the
    // ones already planned between its target and its gate, and walking it would plan them
    // a second time — which is the "reached more than once" problem, i.e. the reading in
    // which a loop is a defect. Taken out here, every traversal below is a DAG traversal
    // again: the walk terminates, the topological order is total, and the transitive
    // closure (which a cycle would fill wrongly) is available. Where the branch went is
    // not lost — it is carried on the branch that loops, as [`PlannedBranch.loopBackTo`].
    if (loops.has(edge.id)) continue;
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
        // Deduplicated: two edges to one node are one path, and instructing it twice
        // is precisely what the "reached more than once" problem exists to prevent.
        const paths = [...new Set(edges.map((edge) => edge.target))];
        if (paths.length <= 1) {
          cursor = paths[0];
          continue;
        }
        // A **plain split**: every path is followed, unlike a conditional's branches,
        // where exactly one is. So it needs no segment of its own — the paths are
        // appended to this same list, in the order the user drew them, and the walk
        // resumes at the node they converge on. What tells a reader the paths are
        // related is the convergence point itself, which reads its inputs under their
        // labels (see the Graph Compiler's fan-in prose).
        //
        // The scoping is the conditional's, for the same reason: a path must stop
        // *before* the convergence point, or the merge would be instructed once per
        // path.
        pushWalks(
          jobs,
          paths.map((start) => ({ collect: job.collect, start })),
          convergence(paths, indexOf()),
          job.collect,
        );
        break;
      }

      // The node each branch leaves by. First edge wins for a branch wired twice
      // (also a validation error), so the plan is a function of document order.
      const heads = new Map<string, string>();
      for (const edge of edges) {
        if (edge.branch === undefined) continue;
        if (!heads.has(edge.branch)) heads.set(edge.branch, edge.target);
      }

      const join = convergence([...new Set(heads.values())], indexOf());
      const branchLoops = looping.get(node.id);
      const planned: PlannedBranch[] = branchesOf(node).map((branch) => {
        // `branch?.id`, like every other read of a branch entry: a hand-built document may
        // hold anything in that array.
        const loop = branchLoops?.get(branch?.id as string);
        return loop === undefined
          ? { branch, segments: [] }
          : { branch, segments: [], loopBackTo: loop.target };
      });
      job.collect.push({ kind: "branch", node, branches: planned });

      const bodies: WalkBody[] = [];
      for (const entry of planned) {
        // `entry.branch?.id`, because a hand-built document can hold anything in that array and
        // this module's promise is that nothing here throws for any document. A branch that is
        // not an object wires to nothing, which is what an unwired branch already does.
        const branchId = entry.branch?.id;
        const head = branchId === undefined ? undefined : heads.get(branchId);
        // An unwired branch contributes no steps rather than no branch: the umbrella
        // still shows the choice the user drew, and validation refuses the export.
        if (head === undefined) continue;
        bodies.push({ collect: entry.segments, start: head });
      }
      pushWalks(jobs, bodies, join, job.collect);
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

/** Where the plan puts a node: how far in it is read, and which list it belongs to. */
export interface Placement {
  /** Position in reading order, which is [`plannedNodes`]' order. */
  at: number;
  /** The segment list it sits in — the main sequence, or one branch of one branch point. */
  list: number;
}

/**
 * Place every node the plan holds, in one pre-order walk.
 *
 * Both halves answer a question about *edges* that the nodes alone cannot: which of them
 * carry a result into a step that reads several at once (see [`fanInInputs`]). The list
 * identity is why this is a walk of the plan rather than a scan of the document — "these
 * two results arrive together" is a fact about the traversal, not about the graph.
 *
 * Iterative, like every other traversal here: nesting is whatever the user drew.
 */
export function placements(plan: WorkflowPlan): Map<string, Placement> {
  const placed = new Map<string, Placement>();
  const stack: Array<{ segment: FlowSegment; list: number }> = [];
  const push = (segments: readonly FlowSegment[], list: number) => {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      stack.push({ segment: segments[index], list });
    }
  };
  push(plan.segments, 0);

  let at = 0;
  let lists = 0;
  while (stack.length > 0) {
    const { segment, list } = stack.pop() as { segment: FlowSegment; list: number };
    // First placement wins, so a document with duplicate node ids (which `validateGraph`
    // refuses) reads as the first of them rather than throwing.
    if (!placed.has(segment.node.id)) placed.set(segment.node.id, { at, list });
    at += 1;
    if (segment.kind !== "branch") continue;
    for (let branch = segment.branches.length - 1; branch >= 0; branch -= 1) {
      lists += 1;
      push(segment.branches[branch].segments, lists);
    }
  }
  return placed;
}

/** One result arriving at a step: the edge that carries it, and what it is called. */
export interface FanInInput {
  edge: GraphEdge;
  label: string;
}

/**
 * What arrives at each node that more than one path leads into, under the labels the
 * results arrive with — keyed by node id, in the order the edges were drawn.
 *
 * **One rule, asked in two places.** The Graph Compiler renders these labels into the
 * step that reads them, and `validateGraph` refuses a pair of them a reader could not
 * tell apart; a second, independently derived notion of "these arrive together" would
 * drift into refusing documents the compiler emits perfectly well — which is exactly what
 * happened when validation worked from the raw edges. It lives here because every part of
 * the answer is a fact about the *plan*.
 *
 * Four edges are deliberately not inputs:
 *
 * - a **branch** edge, because a conditional's branches are alternatives rather than
 *   inputs: exactly one of them arrives, so there is nothing to concatenate;
 * - an edge that leaves a **branch body**, which is the same exclusion one step further
 *   on. The edges arriving at a conditional's convergence point are the tails of its
 *   branches, and once a branch has a step of its own — the ordinary case — none of them
 *   carries a `branch` field any more. Only their **list** still says they are
 *   alternatives, and a fan-in is two paths that are *both* followed, which is exactly
 *   the pair the plan collects into one list;
 * - an edge whose endpoint the plan never placed, which is a document `validateGraph`
 *   refuses; and
 * - a **loop-back**, an edge arriving from a step that comes *later* in the plan. That is
 *   the distinction this exists to make: a fan-in **concatenates** its inputs under
 *   labels, while a loop-back carries the next pass's value and **replaces** what the step
 *   worked on last time. Counting incoming edges cannot tell them apart — direction can.
 *   (Slice 6 landed the loops this was written for, and a loop-back is a *branch* edge on
 *   top of being a backward one, so it is excluded twice over — which is the point: the
 *   step it returns to is told its input is replaced, never concatenated.)
 *
 * A node with a single input is absent: one result needs no name, and nothing about it
 * can be ambiguous.
 */
export function fanInInputs(
  doc: PatchworkDocument,
  plan: WorkflowPlan,
): Map<string, FanInInput[]> {
  const placed = placements(plan);
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));

  const arriving = new Map<string, FanInInput[]>();
  for (const edge of doc.edges) {
    if (edge.branch !== undefined && edge.branch !== "") continue;
    const from = placed.get(edge.source);
    const to = placed.get(edge.target);
    if (from === undefined || to === undefined) continue;
    if (from.at >= to.at) continue;
    if (from.list !== to.list) continue;
    const inputs = arriving.get(edge.target) ?? [];
    inputs.push({ edge, label: inputLabelOf(edge, byId.get(edge.source)) });
    arriving.set(edge.target, inputs);
  }

  const fanIn = new Map<string, FanInInput[]>();
  for (const [id, inputs] of arriving) {
    if (inputs.length > 1) fanIn.set(id, inputs);
  }
  return fanIn;
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
