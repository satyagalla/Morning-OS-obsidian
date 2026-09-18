let activeEditors = 0;
const settledListeners = new Set<() => void>();
const editorCleanups = new Map<HTMLElement, () => void>();

/** Session-local only. It prevents a refresh from replacing a live DOM editor. */
export function beginEditingSession(): () => void {
  activeEditors++;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    activeEditors = Math.max(0, activeEditors - 1);
    if (activeEditors === 0) for (const listener of settledListeners) listener();
  };
}

export function onEditingSessionsSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}

export function hasActiveEditingSession(): boolean {
  return activeEditors > 0;
}

/** Result regions can be replaced without unloading their owning ItemView. */
export function registerEditorCleanup(scope: HTMLElement, cleanup: () => void): () => void {
  editorCleanups.set(scope, cleanup);
  return () => editorCleanups.delete(scope);
}

export function disposeEditorsIn(parent: HTMLElement): void {
  for (const [scope, cleanup] of [...editorCleanups]) {
    if (parent === scope || parent.contains(scope)) {
      editorCleanups.delete(scope);
      cleanup();
    }
  }
}
