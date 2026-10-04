# @kyoot/platform

The file system and processes as kyoot effects; the handler you pipe in (`Memory`, `Node`) decides what they touch. Interception is a policy, not a sandbox.

See [`examples/`](examples) (`intercept.ts` for `confine`, `audit`, and dry runs) and [`test/`](test).

The Node command handler buffers at most 1 MiB of UTF-8 bytes per stream by default.
Set `Command.Options.maxBuffer` to a nonnegative safe integer to choose a different
byte limit for each of stdout and stderr. Overflow stops the child and produces a
`CommandError`. Zero allows empty output. Interruption forwards the runtime's abort
signal to the child process.

```ts
Command.run("git", ["log"], { maxBuffer: 4 * 1024 * 1024 }).pipe(Node.command);
```
