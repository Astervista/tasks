import { CoreError, getTodo, MAX_DEPTH, openSession, ownMinutes, Status, statusOf, Todo, TodoId, Workspace } from './model';
import { Millis } from './time';

export function childrenOf(workspace: Workspace, parentId: TodoId | null): Todo[] {
  return workspace.todos.filter(todo => todo.parentId === parentId);
}

/** Parent first, root last */
export function ancestorsOf(workspace: Workspace, id: TodoId): Todo[] {
  const result: Todo[] = [];
  const seen = new Set<TodoId>([id]);
  let current = getTodo(workspace, id);
  while (current.parentId != null && !seen.has(current.parentId)) {
    const parent = workspace.todos.find(todo => todo.id === current.parentId);
    if (parent == null) {
      break;
    }
    seen.add(current.parentId);
    result.push(parent);
    current = parent;
  }
  return result;
}

/** 1 for top-level todos */
export function depthOf(workspace: Workspace, id: TodoId): number {
  return ancestorsOf(workspace, id).length + 1;
}

export function descendantsOf(workspace: Workspace, id: TodoId): Todo[] {
  const result: Todo[] = [];
  const queue: TodoId[] = [id];
  while (queue.length > 0) {
    const parentId = queue.shift() as TodoId;
    for (const child of childrenOf(workspace, parentId)) {
      if (child.id !== id) {
        result.push(child);
        queue.push(child.id);
      }
    }
  }
  return result;
}

/** Levels in the subtree rooted at `id` (1 for a leaf) */
export function heightOf(workspace: Workspace, id: TodoId): number {
  const children = childrenOf(workspace, id);
  return 1 + Math.max(0, ...children.map(child => heightOf(workspace, child.id)));
}

export function hasChildren(workspace: Workspace, id: TodoId): boolean {
  return workspace.todos.some(todo => todo.parentId === id);
}

/** Whether `id` (with its whole subtree) can become a child of `parentId` */
export function canMoveTo(workspace: Workspace, id: TodoId, parentId: TodoId | null): boolean {
  try {
    checkMove(workspace, id, parentId);
    return true;
  } catch {
    return false;
  }
}

function checkMove(workspace: Workspace, id: TodoId, parentId: TodoId | null): void {
  getTodo(workspace, id);
  if (parentId == null) {
    return;
  }
  getTodo(workspace, parentId);
  if (parentId === id || ancestorsOf(workspace, parentId).some(todo => todo.id === id)) {
    throw new CoreError('cycle', 'A todo cannot be moved inside itself');
  }
  if (depthOf(workspace, parentId) + heightOf(workspace, id) > MAX_DEPTH) {
    throw new CoreError('too-deep', `Todos can be nested at most ${MAX_DEPTH} levels deep`);
  }
}

/**
 * Moves a todo (with its subtree) under `parentId`, at `index` among the new siblings
 * (end when omitted).
 */
export function moveTodo(workspace: Workspace, id: TodoId, parentId: TodoId | null, index?: number): void {
  checkMove(workspace, id, parentId);
  const todo = getTodo(workspace, id);
  const siblings = childrenOf(workspace, parentId).filter(sibling => sibling !== todo);
  todo.parentId = parentId;
  const position = index == null ? siblings.length : Math.max(0, Math.min(index, siblings.length));
  // Rebuild the order with the todo placed among its new siblings
  const ordered = workspace.todos.filter(other => other !== todo);
  if (position < siblings.length) {
    ordered.splice(ordered.indexOf(siblings[position]), 0, todo);
  } else {
    ordered.push(todo);
  }
  workspace.todos = ordered;
  normalizeOrder(workspace);
}

/** Re-sorts todos into depth-first order, keeping the relative order of siblings */
export function normalizeOrder(workspace: Workspace): void {
  const byParent = new Map<TodoId | null, Todo[]>();
  for (const todo of workspace.todos) {
    const list = byParent.get(todo.parentId) ?? [];
    list.push(todo);
    byParent.set(todo.parentId, list);
  }
  const result: Todo[] = [];
  const visited = new Set<Todo>();
  const visit = (todo: Todo) => {
    if (visited.has(todo)) {
      return;
    }
    visited.add(todo);
    result.push(todo);
    for (const child of byParent.get(todo.id) ?? []) {
      visit(child);
    }
  };
  for (const root of byParent.get(null) ?? []) {
    visit(root);
  }
  // Todos unreachable from the top level (orphans, cycles) are never dropped: repairTree fixes them
  for (const todo of workspace.todos) {
    visit(todo);
  }
  workspace.todos = result;
}

/**
 * Makes the tree valid again after hand edits or merges:
 * - todos whose parent vanished are reattached to the root
 * - cycles are broken by moving a todo of the cycle to the root
 * - subtrees deeper than MAX_DEPTH are lifted until they fit
 * - a done todo cannot have open descendants: such ancestors are reopened
 * Returns human-readable notes about what was repaired.
 */
export function repairTree(workspace: Workspace): string[] {
  const notes: string[] = [];
  const ids = new Set(workspace.todos.map(todo => todo.id));
  for (const todo of workspace.todos) {
    if (todo.parentId != null && !ids.has(todo.parentId)) {
      notes.push(`"${todo.name}" lost its parent and was moved to the top level`);
      todo.parentId = null;
    }
  }
  for (const todo of workspace.todos) {
    const seen = new Set<Todo>();
    let current: Todo | undefined = todo;
    while (current != null && current.parentId != null) {
      if (seen.has(current)) {
        notes.push(`"${current.name}" was part of a cycle and was moved to the top level`);
        current.parentId = null;
        break;
      }
      seen.add(current);
      const parentId: TodoId = current.parentId;
      current = workspace.todos.find(other => other.id === parentId);
    }
  }
  normalizeOrder(workspace);
  for (const todo of workspace.todos) {
    while (todo.parentId != null && depthOf(workspace, todo.parentId) + heightOf(workspace, todo.id) > MAX_DEPTH) {
      const parent = getTodo(workspace, todo.parentId);
      notes.push(`"${todo.name}" was nested too deep and was moved up one level`);
      todo.parentId = parent.parentId;
    }
  }
  normalizeOrder(workspace);
  for (const todo of workspace.todos) {
    if (todo.completed == null) {
      for (const ancestor of ancestorsOf(workspace, todo.id)) {
        if (ancestor.completed != null) {
          notes.push(`"${ancestor.name}" was reopened because "${todo.name}" is still open`);
          ancestor.completed = null;
        }
      }
    }
  }
  return notes;
}

export interface Rollup {
  ownMinutes: number;
  /** Own + all descendants */
  totalMinutes: number;
  /** Own weight + the weight of all descendants (a macrotask's own weight is its implicit leaf's) */
  weight: number;
  doneWeight: number;
  leaf: boolean;
}

export function rollups(workspace: Workspace, now: Millis): Map<TodoId, Rollup> {
  const result = new Map<TodoId, Rollup>();
  // Document order is depth-first, so walking it backwards visits children before parents
  for (let i = workspace.todos.length - 1; i >= 0; i--) {
    const todo = workspace.todos[i];
    const children = childrenOf(workspace, todo.id)
      .map(child => result.get(child.id))
      .filter((rollup): rollup is Rollup => rollup != null);
    const own = ownMinutes(todo, now);
    if (children.length === 0) {
      result.set(todo.id, {
        ownMinutes: own,
        totalMinutes: own,
        weight: todo.weight,
        doneWeight: todo.completed != null ? todo.weight : 0,
        leaf: true,
      });
    } else {
      result.set(todo.id, {
        ownMinutes: own,
        totalMinutes: own + children.reduce((sum, child) => sum + child.totalMinutes, 0),
        weight: todo.weight + children.reduce((sum, child) => sum + child.weight, 0),
        doneWeight: (todo.completed != null ? todo.weight : 0) + children.reduce((sum, child) => sum + child.doneWeight, 0),
        leaf: false,
      });
    }
  }
  return result;
}

/**
 * Status of a todo including its subtasks: a macrotask is running while any subtask runs, and paused
 * once any work was logged in its subtree.
 */
export function subtreeStatus(workspace: Workspace, id: TodoId): Status {
  const todo = getTodo(workspace, id);
  if (todo.completed != null) {
    return 'done';
  }
  const subtree = [todo, ...descendantsOf(workspace, id)];
  if (subtree.some(item => openSession(item) != null)) {
    return 'running';
  }
  return subtree.some(item => statusOf(item) !== 'new') ? 'paused' : 'new';
}
