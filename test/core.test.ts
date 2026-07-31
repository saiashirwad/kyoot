import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callUser, opKyoot, pureKyoot } from '../src/core.ts'
import { makeHandler } from '../src/handler.ts'
import { Kyoot, Var } from '../src/index.ts'

test('map auto-flattens a returned Kyo', () => {
  const n = Kyoot.runSync(Kyoot.succeed(1).map((x) => Kyoot.succeed(x + 1)))
  assert.equal(n, 2)
})

test('map chains are trampolined: 100k maps, no stack overflow', () => {
  let k = Kyoot.succeed(0)
  for (let i = 0; i < 100_000; i++) k = k.map((x) => x + 1)
  assert.equal(Kyoot.runSync(k), 100_000)
})

test('pipe threads the computation through functions', () => {
  const n = Kyoot.succeed(2).pipe(
    (k) => k.map((x) => x + 1),
    (k) => k.map((x) => x * 10),
    Kyoot.runSync,
  )
  assert.equal(n, 30)
})

test('gen: yield* plain values and sub-computations', () => {
  const prog = Kyoot.gen(function*() {
    const a = yield* Kyoot.succeed(1)
    const b = yield* Kyoot.gen(function*() {
      return 2
    })
    return a + b
  })
  assert.equal(Kyoot.runSync(prog), 3)
})

test('gen with an effect, handled', () => {
  const prog = Kyoot.gen(function*() {
    yield* Var.set(5)
    const v = yield* Var.get<number>()
    return v * 2
  }).pipe(Var.run(0))
  assert.deepEqual(Kyoot.runSync(prog), [10, 5])
})

test('a throw inside map is a defect and surfaces at the edge as-is', () => {
  const boom = new Error('boom')
  const k = Kyoot.succeed(1).map(() => {
    throw boom
  })
  assert.throws(() => Kyoot.runSync(k), (e) => e === boom)
})

test('a throw inside a gen body is a defect', () => {
  const boom = new Error('boom')
  const k = Kyoot.gen(function*() {
    yield* Kyoot.succeed(1)
    throw boom
  })
  assert.throws(() => Kyoot.runSync(k), (e) => e === boom)
})

test('runSync on an unhandled effect fails loudly at runtime', () => {
  const k = opKyoot('nope', undefined)
  assert.throws(
    () => Kyoot.runSync(k as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'nope'"),
  )
})

test('one-shot law: a handler that resumes twice produces a defect', () => {
  const k = makeHandler({
    key: 'myfx',
    self: opKyoot('myfx', undefined),
    onOp: (_p, resume) => {
      resume(1)
      return resume(2)
    },
    onPure: (a) => pureKyoot(a),
  })
  assert.throws(
    () => Kyoot.runSync(k as never),
    (e: unknown) => e instanceof Error && e.message.includes('resumed twice'),
  )
})

test('a handler that resumes zero times short-circuits', () => {
  const k = makeHandler({
    key: 'myfx',
    self: Kyoot.gen(function*() {
      yield* opKyoot('myfx', undefined)
      return 'unreachable'
    }).map(() => 'also unreachable'),
    onOp: () => pureKyoot('short'),
    onPure: (a) => pureKyoot(a),
  })
  assert.equal(Kyoot.runSync(k as never), 'short')
})

test('callUser passes control exceptions through untouched', () => {
  assert.equal(
    callUser(() => 42),
    42,
  )
})
