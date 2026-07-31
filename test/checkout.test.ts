import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkout, OutOfStock, productionEdge, testEdge } from '../examples/checkout.ts'
import type { Card, Inventory, Order, OrderEvent, Payments } from '../examples/checkout.ts'
import { Result, Sync } from '../src/index.ts'

const order: Order = {
  id: 'o-1',
  items: [
    { sku: 'book', qty: 1, priceCents: 1200 },
    { sku: 'pen', qty: 3, priceCents: 150 },
  ],
}
const card: Card = { number: '4242' }

const fakeInventory: Inventory = {
  reserve: () => Sync.defer(() => true),
}
const alwaysApprove: Payments = {
  charge: (total) => Sync.defer(() => `ch_${total}`),
}

test('test edge: sync fakes run to a receipt under runSync', () => {
  const [receipt, total] = testEdge(order, card, {
    inventory: fakeInventory,
    payments: alwaysApprove,
  })
  assert.equal(total, 1650)
  assert.deepEqual(receipt, { orderId: 'o-1', chargeId: 'ch_1650', totalCents: 1650 })
})

test('production edge: success is Result.ok, events stream out in order', async () => {
  const events: OrderEvent[] = []
  const r = await productionEdge(order, card, {
    inventory: fakeInventory,
    payments: alwaysApprove,
    publish: (e) => events.push(e),
  })
  assert.deepEqual(events, [
    { type: 'reserved', sku: 'book' },
    { type: 'reserved', sku: 'pen' },
  ])
  assert.ok(Result.isOk(r))
  assert.deepEqual(Result.isOk(r) && r.value, [
    { orderId: 'o-1', chargeId: 'ch_1650', totalCents: 1650 },
    1650,
  ])
})

test('production edge: out of stock is a typed failure, transactional state', async () => {
  const outOfStockInventory: Inventory = {
    reserve: (sku) => Sync.defer(() => sku !== 'pen'),
  }
  const r = await productionEdge(order, card, {
    inventory: outOfStockInventory,
    payments: alwaysApprove,
    publish: () => {},
  })
  assert.ok(Result.isErr(r))
  const cause = Result.isErr(r) && r.cause
  assert.ok(cause && cause._tag === 'Fail' && cause.error instanceof OutOfStock)
  // transactional: Var ran before Abort, so the failure is not wrapped in [A, state]
  assert.equal(Array.isArray(r), false)
})

test('test edge: a thrown typed failure surfaces via orThrow', () => {
  const outOfStockInventory: Inventory = {
    reserve: () => Sync.defer(() => false),
  }
  assert.throws(
    () => testEdge(order, card, { inventory: outOfStockInventory, payments: alwaysApprove }),
    (e) => e instanceof OutOfStock,
  )
})
