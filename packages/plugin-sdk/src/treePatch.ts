import type { PluginNode } from "./protocol";

export type TreeChild = PluginNode | string;

export type TreePath = number[];

export type TreeOp =
  | { op: "replace"; path: TreePath; node: TreeChild }
  | { op: "props"; path: TreePath; set?: Record<string, unknown>; unset?: string[] }
  | { op: "insert"; path: TreePath; index: number; nodes: TreeChild[] }
  | { op: "remove"; path: TreePath; index: number; count: number };

export type SurfacePatchParams = { surfaceId: string; base: number; rev: number; ops: TreeOp[] };

export class TreePatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreePatchError";
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => deepEqual(item, other[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

const sameIdentity = (a: TreeChild | undefined, b: TreeChild | undefined): boolean => {
  if (a === undefined || b === undefined) return false;
  if (typeof a === "string" || typeof b === "string") return typeof a === typeof b;
  return a.type === b.type && (a.key ?? null) === (b.key ?? null);
};

function diffProps(a: PluginNode, b: PluginNode, path: TreePath, ops: TreeOp[]) {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const key of Object.keys(b.props)) if (!Object.hasOwn(a.props, key) || !deepEqual(a.props[key], b.props[key])) set[key] = b.props[key];
  for (const key of Object.keys(a.props)) if (!Object.hasOwn(b.props, key)) unset.push(key);
  if (Object.keys(set).length || unset.length) ops.push({ op: "props", path, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) });
}

function diffChildren(a: readonly TreeChild[], b: readonly TreeChild[], path: TreePath, ops: TreeOp[]) {
  let start = 0;
  while (start < a.length && start < b.length && sameIdentity(a[start], b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && sameIdentity(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  for (let i = 0; i < start; i++) diffNode(a[i]!, b[i]!, [...path, i], ops);
  const removed = endA - start;
  const added = endB - start;
  if (removed === added) {
    for (let i = start; i < endA; i++) diffNode(a[i]!, b[i]!, [...path, i], ops);
  } else {
    if (removed) ops.push({ op: "remove", path, index: start, count: removed });
    if (added) ops.push({ op: "insert", path, index: start, nodes: b.slice(start, endB) });
  }
  for (let i = 0; i < a.length - endA; i++) diffNode(a[endA + i]!, b[endB + i]!, [...path, endB + i], ops);
}

function diffNode(a: TreeChild, b: TreeChild, path: TreePath, ops: TreeOp[]) {
  if (a === b) return;
  if (typeof a === "string" || typeof b === "string" || !sameIdentity(a, b)) {
    if (!deepEqual(a, b)) ops.push({ op: "replace", path, node: b });
    return;
  }
  diffProps(a, b, path, ops);
  diffChildren(a.children, b.children, path, ops);
}

export function diffTree(previous: PluginNode | null | undefined, next: PluginNode): TreeOp[] {
  if (!previous) return [{ op: "replace", path: [], node: next }];
  const ops: TreeOp[] = [];
  diffNode(previous, next, [], ops);
  return ops;
}

const isNode = (value: unknown): value is PluginNode =>
  typeof value === "object" && value !== null && typeof (value as PluginNode).type === "string" && Array.isArray((value as PluginNode).children) && typeof (value as PluginNode).props === "object";

const isChild = (value: unknown): value is TreeChild => typeof value === "string" || isNode(value);

const isPath = (value: unknown): value is TreePath => Array.isArray(value) && value.every((i) => Number.isInteger(i) && i >= 0);

function update(node: TreeChild, path: TreePath, depth: number, change: (target: TreeChild) => TreeChild): TreeChild {
  if (depth === path.length) return change(node);
  if (typeof node === "string") throw new TreePatchError(`The patch path ${path.join("/")} goes through text`);
  const index = path[depth]!;
  const child = node.children[index];
  if (child === undefined) throw new TreePatchError(`The patch path ${path.join("/")} has no child at ${index}`);
  const children = node.children.slice();
  children[index] = update(child, path, depth + 1, change);
  return { ...node, children };
}

const asNode = (target: TreeChild, op: string): PluginNode => {
  if (typeof target === "string") throw new TreePatchError(`A ${op} op can't target text`);
  return target;
};

function applyOne(tree: TreeChild, op: TreeOp): TreeChild {
  if (typeof op !== "object" || op === null || !isPath((op as { path?: unknown }).path)) throw new TreePatchError("A patch op needs a path");
  switch (op.op) {
    case "replace":
      if (!isChild(op.node)) throw new TreePatchError("A replace op needs a node");
      return update(tree, op.path, 0, () => op.node);
    case "props":
      return update(tree, op.path, 0, (target) => {
        const node = asNode(target, "props");
        const props = { ...node.props, ...(op.set ?? {}) };
        for (const key of op.unset ?? []) delete props[key];
        return { ...node, props };
      });
    case "insert":
      if (!Array.isArray(op.nodes) || !op.nodes.every(isChild)) throw new TreePatchError("An insert op needs nodes");
      return update(tree, op.path, 0, (target) => {
        const node = asNode(target, "insert");
        if (!Number.isInteger(op.index) || op.index < 0 || op.index > node.children.length) throw new TreePatchError(`Can't insert at ${op.index}`);
        const children = node.children.slice();
        children.splice(op.index, 0, ...op.nodes);
        return { ...node, children };
      });
    case "remove":
      return update(tree, op.path, 0, (target) => {
        const node = asNode(target, "remove");
        if (!Number.isInteger(op.index) || !Number.isInteger(op.count) || op.index < 0 || op.count < 1 || op.index + op.count > node.children.length) {
          throw new TreePatchError(`Can't remove ${op.count} at ${op.index}`);
        }
        const children = node.children.slice();
        children.splice(op.index, op.count);
        return { ...node, children };
      });
    default:
      throw new TreePatchError(`Unknown patch op ${String((op as { op?: unknown }).op)}`);
  }
}

export function applyTreePatch(tree: PluginNode | null, ops: readonly TreeOp[]): PluginNode {
  if (!Array.isArray(ops)) throw new TreePatchError("A patch is a list of ops");
  let current: TreeChild | null = tree;
  for (const op of ops) {
    if (current === null) {
      if (op?.op !== "replace" || !isPath(op.path) || op.path.length !== 0) throw new TreePatchError("A patch on no tree must start by replacing the root");
      current = op.node;
      continue;
    }
    current = applyOne(current, op);
  }
  if (current === null || typeof current === "string") throw new TreePatchError("A patch must leave a node at the root");
  return current;
}
