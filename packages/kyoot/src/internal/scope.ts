export interface OwnedFiber {
  readonly promise: Promise<unknown>;
  readonly interrupt: () => void;
}

export type Finalizer = () => unknown;

export const ScopeAwait = Symbol("kyoot/scope-await");

export interface ScopeAwaitOp {
  readonly execute: () => Promise<void>;
}

export class Scope {
  private readonly children = new Set<OwnedFiber>();
  private readonly finalizers: Finalizer[] = [];
  private closing = false;

  addFinalizer(finalizer: Finalizer): void {
    if (this.closing) throw new Error("resource acquired after its scope began closing");
    this.finalizers.push(finalizer);
  }

  own(fiber: OwnedFiber): void {
    if (this.closing) {
      fiber.interrupt();
      return;
    }
    this.children.add(fiber);
    const remove = () => this.children.delete(fiber);
    void fiber.promise.then(remove, remove);
  }

  close(): { readonly children: Promise<void> | undefined; readonly finalizers: Finalizer[] } {
    if (this.closing) return { children: undefined, finalizers: [] };
    this.closing = true;

    const children = [...this.children];
    this.children.clear();
    for (const child of children) child.interrupt();

    const finalizers = this.finalizers.splice(0).reverse();
    return {
      children:
        children.length === 0
          ? undefined
          : Promise.allSettled(children.map((child) => child.promise)).then(() => undefined),
      finalizers,
    };
  }
}
