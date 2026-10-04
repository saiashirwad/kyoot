# @kyoot/platform

The file system and processes as kyoot effects; the handler you pipe in (`Memory`, `Node`) decides what they touch. Interception is a policy, not a sandbox.

See [`examples/`](examples) (`intercept.ts` for `confine`, `audit`, and dry runs) and [`test/`](test).

`FileSystem` operations carry a `FileSystem.FileSystemRow` requirement. Its answer
depends on the operation kind, so ordinary fixed-answer handlers created with
`effect()` or `makeHandler()` cannot handle it. Use `Memory.fs()`, `Node.fs`, or
`Node.provide` to interpret filesystem programs.

Custom replacements use `FileSystem.unsafeHandle`, `FileSystem.unsafeHandler`, or
`FileSystem.unsafeIntercept`. These callbacks accept unknown answers and must
preserve the operation's result contract themselves. They replace the former
`handle`, `handler`, and `intercept` names.

| Operation                                              | Result            |
| ------------------------------------------------------ | ----------------- |
| `readFile`                                             | `string`          |
| `readDir`                                              | `string[]`        |
| `stat`                                                 | `FileSystem.Stat` |
| `exists`                                               | `boolean`         |
| `writeFile`, `appendFile`, `mkdir`, `remove`, `rename` | `void`            |

For example, an interceptor can log the request and forward it unchanged:

```ts
const audit = FileSystem.unsafeIntercept((op, next) =>
  Log.info(`${op.kind} ${op.path}`).flatMap(() => next(op)),
);
```

Returning a different value, or forwarding a different operation kind, can break
the caller's result type. The unsafe APIs leave that check to the callback author.

The Node command handler buffers at most 1 MiB of UTF-8 bytes per stream by default.
Set `Command.Options.maxBuffer` to a nonnegative safe integer to choose a different
byte limit for each of stdout and stderr. Overflow stops the child and produces a
`CommandError`. Zero allows empty output. Interruption forwards the runtime's abort
signal to the child process.

```ts
Command.run("git", ["log"], { maxBuffer: 4 * 1024 * 1024 }).pipe(Node.command);
```
