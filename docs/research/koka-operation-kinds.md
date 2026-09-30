# Koka operation kinds, clause scope, and masking (with OCaml 5 contrast)

Research for [ticket #28](https://github.com/saiashirwad/kyoot/issues/28), feeding [kernel map #20](https://github.com/saiashirwad/kyoot/issues/20). Researched 2026-10-01 using primary sources only. Koka book consulted: dated 2026-09-17; OCaml baseline: manual 5.3 (effects introduced in 5.0; deep-handler syntax in 5.3).

## Answer in brief

- Koka `ctl` exposes a first-class resumption; `fun` implicitly tail-resumes once with its body's result; `val` binds a value evaluated before handling, not a computation rerun on each access. [K1–K3]
- **`fun` does not mean operation-site effect scope.** Its direct-call implementation adjusts the evidence/handler context so effects in the clause resolve as if the clause ran outside its matching handler. Intervening handlers at the operation site do not become the clause's ambient handlers. [P, §2.5, §2.9.2]
- Yes: Koka tail-resumptive dispatch avoids capturing that operation's continuation. This does not make an effectful clause immune to another, general control operation capturing a continuation. [K2; P, §2.9.2]
- `mask<E>` skips one currently available handler of `E` for its action; it neither suppresses the operation nor makes it pure. Ordinary same-effect forwarding **from a clause** already runs outside that clause's handler and does not need a mask to bypass itself. [K4; P, §2.5]
- OCaml 5 has general effects with runtime-enforced one-shot continuations, not Koka's `fun`/`val`/`ctl` classification. Deepness reinstalls the handler in the resumed computation, not around the clause body. [O1–O3]

## 1. Operation declarations versus handler clauses

These are two different decisions: what implementations an effect declaration permits, and what a particular handler clause does. An effect declared with `ctl` may have a tail-resumptive `fun` implementation; declaring the operation `fun` upfront restricts all its handler definitions to `fun` and removes the runtime need to test whether a particular implementation is tail-resumptive. [K2]

| Handler clause | Exact operational intent | Result/control behavior |
| --- | --- | --- |
| `ctl op(args) { body }` | Gives `body` an implicit first-class `resume` representing the delimited remainder of the handled computation. | May omit resumption, resume once, or resume multiple times; the clause's result is the handled computation's result, not automatically the operation result. [K1, K5] |
| `fun op(args) { body }` | Equivalent to `ctl op(args) { val f = fn() { body }; resume(f()) }`. The intermediate function preserves the meaning of `return` inside `body`. | On normal completion, the body's value is supplied as the operation result through one tail resumption; there is no exposed resumption to save or call twice. [K2] |
| `val v = expr` | Equivalent to first evaluating `val x = expr`, then installing `fun v() { x }` (and hence `ctl v() { resume(x) }`). | Repeated accesses return the same bound value; initializer effects happen before the new handler is installed. This is a typed dynamically bound value, not a thunk rerun per access. [K3] |

“Resumes once” describes the `fun` clause's own normal-return protocol, not a totality guarantee: `body` can perform other effects, including a control effect that aborts or suspends. The generalized-evidence paper explicitly places a non-scoped control operation *inside* a tail-resumptive clause. [P, §2.9.2]

An `effect val width : int` allows use as `width` rather than `width()`, but an access is still internally an operation. A handler `return(x)` clause transforms normal completion of the handled action; it is distinct from the result of an individual operation. Koka's `raise-maybe` example returns `Just(x)` on normal completion and `Nothing` from a non-resuming `ctl raise` clause. [K3, K6]

## 2. Which handlers see effects performed inside a clause?

### The semantic boundary, not the physical stack position

For ordinary Koka handlers, the operation's delimited continuation includes the matching handler and the computation between that handler and the operation. The clause executes outside that boundary. Resuming restores the delimited computation, including the handler (deep behavior). [P, §2.1]

For a tail-resumptive implementation, Koka instead calls the clause in place as a regular function, but adjusts its evidence vector to the matching handler's outer context. The paper's `under` frame is essential: using the unmodified operation-site evidence would give different semantics, including accidental self-recursion when a clause calls the same operation. [K2; P, §2.5]

A schematic scope test (notation below is explanatory, not compilable Koka):

```text
handle Log with OUTER:
  handle Ask with (fun ask() = log("in clause"); 42):
    handle Log with INNER:
      ask()
      log("after ask")
```

**Prediction from these semantics:** `log("in clause")` goes to OUTER, while `log("after ask")` goes to INNER. Replacing the Ask clause by `ctl ask() { log("in clause"); resume(42) }` preserves that routing. This example is a derivation from the paper's handler/evidence rules, not a claimed compiler run. [P, §2.1, §2.5]

Likewise, the paper's nested reader example has an inner clause implementing `ask` by performing an outer `ask` and adding one. It returns 2 when the outer handler supplies 1; it does not recursively call itself. This is the basic interceptor/decorator pattern. [P, §2.5, pp. 8–9]

### Important qualification: not permanently frozen lexical evidence

“Handler site” here means the outer dynamic context of the relevant handler boundary, **not** a permanently frozen snapshot from when a handler closure was constructed. Generalized evidence passing supports escaped resumptions invoked under a different outer handler. The paper shows reads changing from 1 to 2 after such a move; even an optimized tail-resumptive clause must use the updated outer context. Its `under l` frame cannot be replaced by a fixed `under old-evidence-vector`. [P, §2.9.1–2.9.2]

## 3. Does `fun` avoid continuation capture?

**Yes, for that tail-resumptive dispatch.** The Koka book explicitly says the compiler selects a handler from the evidence vector and directly calls a tail-resumptive clause with adjusted evidence: no yielding upward, stack capture, or subsequent explicit resumption is needed. It describes `fun` and `val` costs as similar to virtual method calls. The paper formalizes the tail-resumptive shape as `op ↦ λx. λk. k e`, where `k` is not free in `e`, and evaluates `e` in place. [K2; P, §2.5]

Do not conflate three promises:

1. A **`fun` clause** allows this dispatch optimization. [K2]
2. A **`fun` operation declaration** guarantees all implementations are tail-resumptive and can eliminate the runtime clause-kind check. [K2]
3. A **linear effect** gives a stronger static restriction against general control operations and permits removing monadic transformation overhead in affected polymorphic code. [K2, §3.4.3 advanced note]

None is a claim that arbitrary calls made inside an ordinary `fun` clause cannot capture: the paper's §2.9.2 counterexample explicitly does so. No benchmark or zero-allocation claim for kyoot follows from Koka's implementation strategy.

## 4. `mask`: bypass one layer, preserve abstraction

The book specifies `mask<E>(action)` as masking the innermost handler for the effect in that action. Its canonical example is:

```koka
fun mask-emit()
  with fun emit(msg) println("outer:" ++ msg)
  with fun emit(msg) println("inner:" ++ msg)
  emit("hi")
  mask<emit>
    emit("there")
```

The documented output is `inner: hi`, then `outer: there`. Masking skips **one** layer, not all handlers, and applies to operations executed by the action, not merely to the next textual call. [K4]

The schematic type is:

```text
mask<l> : (action : () -> e a) -> <l|e> a
```

It injects a label into the enclosing effect row rather than discharging one. For `mask<emit> { emit("there") }`, the row contains two `emit` labels: one handler to skip and another to service the operation. Thus “mask” is not swallowing, delaying, disabling, or declaring absence of an effect. [K4]

Uses and consequences:

- **Hide private handling from callbacks.** A library installs an internal `raise` handler, invokes caller-supplied `action` through `mask<raise>`, and still handles its own later raises. Caller exceptions bypass the private handler; the callback type stays `() -> e int` rather than advertising that the library handles its exceptions. This is the book's `mask-print` example. [K4]
- **Bypass an interceptor from inside its handled action.** If an interceptor is still active in the action's current handler context, masking its effect selects the next outer layer. This follows directly from `mask-emit`. [K4]
- **Do not blindly mask forwarding inside the interceptor clause.** The clause already uses its handler's outer context; calling the same operation forwards outward normally. A further mask would skip an additional outer handler, not merely the interceptor itself. This is a deduction combining the documented masking rule with the paper's forwarding example. [K4; P, §2.5]
- **Handler/type abstraction is separate from continuation control.** Masking changes handler availability for a computation; it does not supply a resumption or turn a multi-shot operation into a one-shot one. [K4; P, §2.1]

## 5. OCaml 5 contrast

OCaml extends `Effect.t` with operation constructors and uses `perform`. A matching handler receives a delimited continuation; `continue k value` resumes it, and `discontinue k exn` raises an exception at the suspended perform point. OCaml does not statically guarantee all effects are handled; an unmatched perform raises `Effect.Unhandled`. [O1, O2]

| Question | OCaml 5 answer |
| --- | --- |
| Clause context? | Control switches out to the matching handler; the continuation holds the suspended stack segment. Effects newly performed in the clause therefore use outer handlers, not handlers suspended between it and the original perform. This follows from the manual's fiber diagrams. [O2] |
| What does deep mean? | The captured continuation includes the handler and automatically reinstalls it on resumption. It does not mean the clause handles its own effects. [O3] |
| What does shallow mean? | The continuation does not include the matching handler; resumption supplies a handler explicitly, such as via `continue_with`. [O3] |
| Can a continuation run twice? | No: a second resumption raises `Continuation_already_resumed`. The runtime enforces at most once; the programmer must ensure at least once (continue or discontinue) to avoid leaked fibers/resources. [O2] |
| Does immediate tail `continue` imply no capture? | The manual describes a heap continuation referring to a suspended fiber segment, with no stack-frame copying. It does **not** give a Koka-like no-capture guarantee for tail-resuming clauses. [O2] |
| Forwarding? | Unmatched effects go outward; in the record API, `effc` returning `None` requests forwarding. Do not confuse declining an operation with handling it and performing a new one. [O1, O3] |

There is no Koka-style typed `mask<E>` construct in the cited OCaml effect-handler API/manual. This is a statement about the documented interface, not a claim that no library can implement selective bypass or interception. [O1–O3]

## 6. Implications for kyoot's serve/handle and intercept decisions

These are recommendations derived from the research, **not decisions imposed on kyoot**:

1. Specify **resumption power** and **clause effect scope** separately. A “serve” operation can be direct-return/tail-resumptive while still giving its clause handler-site scope; choosing direct execution must not accidentally expose operation-site inner handlers. [K2; P, §2.5]
2. Give an interceptor an explicit forwarding rule. Handler-site clauses naturally forward by invoking the outer operation; operation-site callbacks would need a separate bypass mechanism to avoid self-interception. Do not name both behaviors `mask` without defining the starting context. [K4; P, §2.5]
3. Test the OUTER/INNER trace above, same-effect forwarding, callback masking, and resumption under changed outer handlers. Those cases distinguish superficially similar implementations. [P, §2.5, §2.9; K4]
4. Do not infer Koka-style allocation savings merely from a generator callback returning a value. Koka has dedicated evidence dispatch and compilation support; any analogous kyoot claim needs implementation inspection and measurement. [K2; P, §2.5–2.8]

## Evidence limits

This is documentation and formal-semantics research, not a compiler experiment: no Koka or OCaml executable tests or kyoot benchmarks were run. The schematic scope test is explicitly derived. The book establishes current surface syntax; the 2021 paper explains the semantics/optimization, not a line-by-line audit of today's generated C. I did not establish whether a particular OCaml compiler can optimize a special immediate-resumption case beyond its documented implementation. No dependencies or application code were changed.

## Primary sources

- **K1:** Daan Leijen, *The Koka Programming Language*, [Resuming Operations, §3.4.2](https://koka-lang.github.io/koka/doc/book.html#sec-resume) (implicit first-class `resume`, non-resuming example).
- **K2:** Same book, [Tail-Resumptive Operations, §3.4.3](https://koka-lang.github.io/koka/doc/book.html#sec-opfun) (translation, evidence dispatch, declaration restriction, linear-effect distinction).
- **K3:** Same book, [Value Operations](https://koka-lang.github.io/koka/doc/book.html#sec-opval) under §3.4.3 (eager binding translation, width example).
- **K4:** Same book, [Masking Effects, §3.4.7](https://koka-lang.github.io/koka/doc/book.html#sec-mask) (skip-one rule, type, duplicate labels, callback abstraction).
- **K5:** Same book, [Resuming more than once, §3.4.10](https://koka-lang.github.io/koka/doc/book.html#sec-multi-resume) (multi-resumption); the paper below also gives multi-shot choice semantics in §2.1.
- **K6:** Same book, [Return Operations, §3.4.5](https://koka-lang.github.io/koka/doc/book.html#sec-return).
- **P:** Ningning Xie and Daan Leijen, *Generalized Evidence Passing for Effect Handlers (or, Efficient Compilation of Effect Handlers to C)*, MSR-TR-2021-5, extended v4, 2021-06-07. [First-party publication record](https://www.microsoft.com/en-us/research/publication/generalized-evidence-passing-for-effect-handlers/), [full paper](https://www.microsoft.com/en-us/research/wp-content/uploads/2021/03/multip-tr-v4.pdf). Especially §2.1 (deep handlers/resumptions), §2.5 pp. 7–9 (tail-resumptive dispatch and forwarding), §2.9 pp. 12–14 (dynamic context and escaped resumptions).
- **O1:** OCaml 5.3 manual, [§12.24.1 Basics](https://ocaml.org/manual/5.3/effects.html#s%3Aeffects-basics), plus §12.24.3's “Resuming with an exception.”
- **O2:** Same manual, [§12.24.5 Semantics](https://ocaml.org/manual/5.3/effects.html#s%3Aeffects-semantics) (nesting, fibers, unhandled effects, linear continuations).
- **O3:** Same manual, [§12.24.6 Shallow handlers](https://ocaml.org/manual/5.3/effects.html#s%3Aeffects-shallow) (deep/shallow distinction and `None` forwarding).
