import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage, { StorageError, storageBackendServiceKey } from '@matter/storage'
import type { KvUnit, StorageBackend } from '@matter/storage'
import { apply, defineDomain, descriptorOf, DomainFacility, domainTable } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { DomainChanged } from '../src/events.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'

const itemSchema = z.object({ label: z.string(), count: z.number().int() })
type Item = z.infer<typeof itemSchema>

const settingsSchema = z.object({ theme: z.string() })

const spec = defineDomain({
  name: 'demo',
  version: 1,
  global: { schema: settingsSchema, initial: { theme: 'plain' } },
  tables: { items: domainTable<string, Item>(itemSchema) },
})

const bareSpec = defineDomain({
  name: 'bare',
  version: 1,
  tables: { rows: domainTable<string, Item>(itemSchema) },
})

/** Boot a context with the storage hub, one KV backend, and a facility over it. */
async function harness(options?: { pool?: MemoryMediaPool; config?: Partial<Config>; backend?: StorageBackend }) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = options?.backend ?? new MemoryStorageBackend(options?.pool)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {}, ...options?.config })
  ctx.storage.mount('domain', facility)
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  return { ctx, backend, facility, changes }
}

describe('defineDomain', () => {
  it('rejects invalid names and versions loudly', () => {
    expect(() => defineDomain({ name: 'Bad-Name', version: 1, tables: {} })).toThrow(/must match/)
    expect(() => defineDomain({ name: 'ok', version: 1.5, tables: {} })).toThrow(/non-negative integer/)
    expect(() => defineDomain({
      name: 'ok', version: 1, tables: { 'Bad Table': domainTable<string, Item>(itemSchema) },
    })).toThrow(/table name/)
  })

  it('rejects a global schema that accepts null (the never-written sentinel)', () => {
    expect(() => defineDomain({
      name: 'ok',
      version: 1,
      global: { schema: settingsSchema.nullable(), initial: null },
      tables: {},
    })).toThrow(/must not accept null/)
  })

  it('validates compatibleVersions entries and projects them onto the descriptor', () => {
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [1.5], tables: {} }))
      .toThrow(/compatibleVersions/)
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [2], tables: {} }))
      .toThrow(/below version/)
    expect(() => defineDomain({ name: 'ok', version: 2, compatibleVersions: [-1], tables: {} }))
      .toThrow(/compatibleVersions/)
    expect(descriptorOf(defineDomain({ name: 'ok', version: 2, compatibleVersions: [0, 1], tables: {} })))
      .toMatchObject({ compatibleVersions: [0, 1] })
    // An undeclared set is absent from the descriptor.
    expect(descriptorOf(spec)).not.toHaveProperty('compatibleVersions')
  })

  it('rejects an unknown invalidRecords policy', () => {
    expect(() => defineDomain({
      name: 'ok', version: 1, invalidRecords: 'zap' as 'backup-and-skip', tables: {},
    })).toThrow(/invalidRecords/)
  })

  it('rejects an invalid layout and projects the declared one onto the descriptor', () => {
    // A spec built from config can carry any value; the union type is
    // compile-time only, so the runtime boundary check must reject it.
    expect(() => defineDomain({ name: 'ok', version: 1, layout: 'every-record' as 'single', tables: {} }))
      .toThrow(/layout/)
    expect(descriptorOf(defineDomain({ name: 'per', version: 1, layout: 'per-record', tables: {} })))
      .toMatchObject({ name: 'per', layout: 'per-record' })
    // The default (single) layout is absent from the descriptor.
    expect(descriptorOf(spec)).not.toHaveProperty('layout')
  })

  it("rejects layout 'single': the provider does not implement it and would silently write per-record", () => {
    // ⛔ 本仓收窄（ISS-514）：DSH 接受 'single'；我们**必须拒绝**。
    // 理由不是"还没实现"，是 `@matter/storage-json` **根本不读这个字段** ——
    // 接受声明而按别的形态落盘，正是 ISS-510 那类静默分叉。
    // 若把 spec.ts 里那条判断删掉，本用例变红。
    expect(() => defineDomain({ name: 'ok', version: 1, layout: 'single', tables: {} }))
      .toThrow(/only layout @matter\/storage-json implements/)
    // 未声明 layout 仍然合法（descriptor 里不出现该键，见上一条）。
    expect(() => defineDomain({ name: 'ok', version: 1, tables: {} })).not.toThrow()
  })
})

describe('DomainFacility.open', () => {
  it('opens, reads back stored records, and rejects a second open of the same name', async () => {
    const { facility } = await harness()
    const domain = await facility.open(spec)
    await domain.table('items').put('a', { label: 'first', count: 1 })
    await expect(facility.open(spec)).rejects.toMatchObject({ name: 'DomainError', code: 'already-open' })
    expect(domain.table('items').get('a')).toEqual({ label: 'first', count: 1 })
  })

  it('routes per domain name and fails loud on an unregistered route target', async () => {
    const { facility } = await harness({ config: { routes: { demo: 'nonexistent' } } })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'backend-not-found',
    })
    // The failed open releases the name for a later attempt.
    const { facility: healthy } = await harness()
    await expect(healthy.open(spec)).resolves.toBeDefined()
  })

  it('rejects a backend without the kv facet', async () => {
    const { ctx, facility } = await harness({ config: { backend: 'nokv' } })
    ctx.storage.backend.register('nokv', { close: async () => {} })
    await expect(facility.open(spec)).rejects.toMatchObject({ code: 'facet-unsupported' })
  })

  it('falls back to the default backend when no route table is configured', async () => {
    // A second, unmounted facility whose config omits `routes` entirely
    // (exactOptionalPropertyTypes forbids an explicit undefined).
    const { ctx } = await harness()
    const routeless = new DomainFacility(ctx, { backend: 'memory' })
    await expect(routeless.open(bareSpec)).resolves.toBeDefined()
  })

  it('treats a table key the backend omitted from loadAll as empty', async () => {
    // A sparse backend: loadAll omits declared table keys entirely instead of
    // returning them as empty objects.
    const { ctx, facility } = await harness({ config: { backend: 'sparse' } })
    ctx.storage.backend.register('sparse', {
      kv: {
        open: async () => ({
          loadAll: async () => ({ tables: {}, global: null }),
          putRecord: async () => {},
          deleteRecord: async () => {},
          deleteRecords: async () => {},
          setGlobal: async () => {},
          close: async () => {},
        }),
      },
      close: async () => {},
    })
    const domain = await facility.open(bareSpec)
    expect(domain.table('rows').size).toBe(0)
  })

})

// ISS-514：拆分点。上一段的 `open` 已到 100 行上限（`lint-complexity` 的
// `max-lines-per-function` 对 describe 回调同样生效 —— 它也是一个函数）。
// 按「路由 / 快照校验」切：前者判的是路由与 facet，后者判的是载入时的 zod 校验。
describe('DomainFacility.open · snapshot validation', () => {
  it('rejects stored records that fail their schema, naming table and key', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      await (await facility.open(spec)).table('items').put('bad', { label: 'x', count: 2 })
    }
    pool.media.get('demo')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
  })

  it('keeps the rejecting default under backup-and-skip when the backend cannot move documents', async () => {
    // The memory backend has no backupRecord, so the declared policy cannot
    // apply and the open falls back to failing loud.
    const salvageSpec = defineDomain({
      name: 'salvage',
      version: 1,
      invalidRecords: 'backup-and-skip',
      tables: { items: domainTable<string, Item>(itemSchema) },
    })
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      await (await facility.open(salvageSpec)).table('items').put('bad', { label: 'x', count: 2 })
    }
    pool.media.get('salvage')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    const { facility } = await harness({ pool })
    await expect(facility.open(salvageSpec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
  })

  it('rejects a stored global that fails its schema with the global marker', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('demo', 1)
    pool.media.set('demo', { tables: new Map(), global: { theme: 42 } })
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: 'invalid-record',
      detail: { table: '', key: '' },
    })
  })

  it('passes through a backend version mismatch', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('demo', 7)
    const { facility } = await harness({ pool })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })
  })
})

describe('plugin apply', () => {
  it('uses only the default backend when routes are omitted', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    const disposeBackend = ctx.provide(storageBackendServiceKey('memory'), backend)

    const fiber = await ctx.plugin({
      name: 'storage-domain-routeless-test',
      inject: ['storage'],
      apply: (domainCtx: Context) => apply(domainCtx, { backend: 'memory' }),
    })
    await vi.waitFor(() => { expect(ctx.storageDomain).toBeInstanceOf(DomainFacility) })

    disposeBackend()
    await vi.waitFor(() => { expect(ctx.get('storageDomain')).toBeUndefined() })
    await fiber.dispose()
  })

  it('waits for routed backends, then mounts one lifecycle-bound service and form', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const DomainPlugin = await import('../src/index.ts')
    const fiber = await ctx.plugin(DomainPlugin, { backend: 'memory' })
    expect(ctx.get('storageDomain')).toBeUndefined()
    expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)

    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    const disposeBackend = ctx.provide(storageBackendServiceKey('memory'), backend)
    await vi.waitFor(() => { expect(ctx.storageDomain).toBeInstanceOf(DomainFacility) })
    expect(ctx.storage.domain).toBe(ctx.storageDomain)

    disposeBackend()
    await vi.waitFor(() => {
      expect(ctx.get('storageDomain')).toBeUndefined()
      expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)
    })
    await fiber.dispose()
  })
})

describe('table and snapshot reads', () => {
  it('serves entries, keys, and size as stable snapshots; unknown table names throw', async () => {
    const { facility } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    expect(table.size).toBe(2)
    expect([...table.keys()].sort()).toEqual(['a', 'b'])
    expect(new Map(table.entries()).get('a')).toEqual({ label: 'x', count: 1 })
    expect(() => domain.table('nope' as never)).toThrow(/declares no table/)
  })
})

describe('KvTable writes', () => {
  it('serializes concurrent updates on one key without losing increments', async () => {
    const { facility } = await harness()
    const table = (await facility.open(spec)).table('items')
    await table.put('counter', { label: 'c', count: 0 })
    await Promise.all(Array.from({ length: 50 }, () =>
      table.update('counter', (current) => ({ ...current, count: current.count + 1 }))))
    expect(table.get('counter')).toEqual({ label: 'c', count: 50 })
  })

  it('update rejects a missing key; delete reports prior existence', async () => {
    const { facility } = await harness()
    const table = (await facility.open(spec)).table('items')
    await expect(table.update('ghost', (v) => v)).rejects.toMatchObject({ code: 'missing-key' })
    await table.put('a', { label: 'x', count: 1 })
    await expect(table.delete('a')).resolves.toBe(true)
    await expect(table.delete('a')).resolves.toBe(false)
  })

  it('deleteMany removes the existing keys in one write slot and reports the count', async () => {
    const { facility, changes } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    await table.put('c', { label: 'z', count: 3 })
    const seen = changes.length
    await expect(table.deleteMany(['a', 'c', 'missing', 'a'])).resolves.toBe(2)
    expect([...table.entries()]).toEqual([['b', { label: 'y', count: 2 }]])
    expect(changes.slice(seen)).toEqual([
      { domain: 'demo', table: 'items', key: 'a', operation: 'deleted' },
      { domain: 'demo', table: 'items', key: 'c', operation: 'deleted' },
    ])
    // A batch without existing keys is a no-op: no backend write and no event.
    await expect(table.deleteMany(['ghost'])).resolves.toBe(0)
    expect(changes).toHaveLength(seen + 2)
  })

  it('applies the whole batch to memory before announcing it', async () => {
    const { ctx, facility } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    const observed: string[][] = []
    ctx.on('domain/changed', () => { observed.push([...table.keys()].sort()) })
    await table.deleteMany(['a', 'b'])
    // Every listener run sees the committed batch state, not a prefix of it.
    expect(observed).toEqual([[], []])
  })

  it('calls the backend batch primitive exactly once per deleteMany', async () => {
    const inner = new MemoryStorageBackend()
    let batches = 0
    let singles = 0
    const counting: StorageBackend = {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const kv = inner.kv
          if (kv === undefined) throw new Error('memory backend is missing its kv facet')
          const unit = await kv.open(descriptor)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: async (table, key) => {
              singles += 1
              return unit.deleteRecord(table, key)
            },
            deleteRecords: async (table, keys) => {
              batches += 1
              return unit.deleteRecords(table, keys)
            },
            setGlobal: (value) => unit.setGlobal(value),
            close: () => unit.close(),
          }
        },
      },
    }
    const { facility } = await harness({ backend: counting })
    const table = (await facility.open(spec)).table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    await expect(table.deleteMany(['a', 'b', 'missing'])).resolves.toBe(2)
    expect(batches).toBe(1)
    expect(singles).toBe(0)
  })

})

// ISS-514：拆分点（`max-lines-per-function` 对 describe 回调生效）。
// 上一段判「一条写如何落地与广播」，这一段判「一次写对一/多 key 的行为」。
describe('KvTable writes · event stream', () => {
  it('emits domain/changed per durable write, in order, with tombstones and global marker', async () => {
    const { facility, changes } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.update('a', (current) => ({ ...current, count: 2 }))
    await table.delete('a')
    await table.delete('a') // no event: already absent
    await domain.global.set({ theme: 'dark' })
    expect(changes).toEqual([
      { domain: 'demo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 1 } },
      { domain: 'demo', table: 'items', key: 'a', operation: 'put', value: { label: 'x', count: 2 } },
      { domain: 'demo', table: 'items', key: 'a', operation: 'deleted' },
      { domain: 'demo', table: '', key: '', operation: 'put', value: { theme: 'dark' } },
    ])
  })
})

describe('durability failure', () => {
  it('leaves memory untouched and emits nothing when the backend rejects a write', async () => {
    const pool = new MemoryMediaPool()
    const { facility, changes } = await harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    const seen = changes.length

    pool.failNextWrites = 3
    await expect(table.put('a', { label: 'x', count: 99 })).rejects.toThrow(/injected/)
    await expect(table.update('a', (c) => ({ ...c, count: c.count + 1 }))).rejects.toThrow(/injected/)
    await expect(table.delete('a')).rejects.toThrow(/injected/)

    // Reads still serve the pre-failure record; no events leaked.
    expect(table.get('a')).toEqual({ label: 'x', count: 1 })
    expect(pool.media.get('demo')!.tables.get('items')!.get('a')).toEqual({ label: 'x', count: 1 })
    expect(changes).toHaveLength(seen)

    // The chain survives rejections: the next write lands cleanly with no residue.
    await table.update('a', (c) => ({ ...c, count: c.count + 1 }))
    expect(table.get('a')).toEqual({ label: 'x', count: 2 })
  })

  it('leaves every record in place when a batch delete fails durability', async () => {
    const pool = new MemoryMediaPool()
    const { facility, changes } = await harness({ pool })
    const table = (await facility.open(spec)).table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    const seen = changes.length

    pool.failNextWrites = 1
    await expect(table.deleteMany(['a', 'b'])).rejects.toThrow(/injected/)

    expect([...table.entries()]).toEqual([
      ['a', { label: 'x', count: 1 }],
      ['b', { label: 'y', count: 2 }],
    ])
    expect(pool.media.get('demo')!.tables.get('items')!.get('b')).toEqual({ label: 'y', count: 2 })
    expect(changes).toHaveLength(seen)

    // The write chain keeps serving after a rejected batch.
    await table.put('c', { label: 'z', count: 3 })
    expect(table.get('c')).toEqual({ label: 'z', count: 3 })
  })

  it('quarantines the domain after a batch reports unknown-state', async () => {
    const inner = new MemoryStorageBackend()
    const poisoned: StorageBackend = {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const kv = inner.kv
          if (kv === undefined) throw new Error('memory backend is missing its kv facet')
          const unit: KvUnit = await kv.open(descriptor)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: (table, key) => unit.deleteRecord(table, key),
            deleteRecords: () => Promise.reject(new StorageError('unknown-state', 'unknown-state injected by the test')),
            setGlobal: (value) => unit.setGlobal(value),
            close: () => unit.close(),
          }
        },
      },
    }
    const { facility } = await harness({ backend: poisoned })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })

    // A later job queued before the failure surfaces is rejected too.
    const failing = table.deleteMany(['a'])
    const queued = table.put('b', { label: 'y', count: 2 })
    await expect(failing).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(queued).rejects.toMatchObject({ code: 'unknown-state' })
    // Synchronous reads and later chain jobs see the quarantined domain.
    expect(() => table.get('a')).toThrow(/unknown-state/)
    expect(() => [...table.keys()]).toThrow(/unknown-state/)
    expect(() => table.size).toThrow(/unknown-state/)
    await expect(table.deleteMany(['missing'])).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(table.put('c', { label: 'z', count: 3 })).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(domain.global.set({ theme: 'dark' })).rejects.toMatchObject({ code: 'unknown-state' })
    expect(() => domain.global.get()).toThrow(/unknown-state/)
    // Releasing the domain stays possible.
    await expect(domain.close()).resolves.toBeUndefined()
  })

  it('keeps serving initial when the first global set fails durability', async () => {
    const pool = new MemoryMediaPool()
    const { facility } = await harness({ pool })
    const domain = await facility.open(spec)
    pool.failNextWrites = 1
    await expect(domain.global.set({ theme: 'dark' })).rejects.toThrow(/injected/)
    expect(domain.global.get()).toEqual({ theme: 'plain' })
    expect(pool.media.get('demo')!.global).toBeNull()
  })
})

describe('global singleton', () => {
  it('serves initial before first set without materializing, then persists the first set', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      const domain = await facility.open(spec)
      expect(domain.global.get()).toEqual({ theme: 'plain' })
      expect(pool.media.get('demo')!.global).toBeNull() // initial never touches the medium
      await domain.global.set({ theme: 'dark' })
      expect(pool.media.get('demo')!.global).toEqual({ theme: 'dark' })
    }
    const { facility } = await harness({ pool })
    expect((await facility.open(spec)).global.get()).toEqual({ theme: 'dark' })
  })

  it('throws on access when the spec declares no global', async () => {
    const { facility } = await harness()
    const domain = await facility.open(bareSpec)
    expect(() => (domain as { global: unknown }).global).toThrow(/declares no global/)
  })
})

describe('close and lifecycle', () => {
  it('close drains queued writes, then rejects reads and writes, and frees the name', async () => {
    const pool = new MemoryMediaPool()
    const { facility } = await harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    const pending = Promise.all([
      table.put('a', { label: 'x', count: 1 }),
      table.put('b', { label: 'y', count: 2 }),
    ])
    await Promise.all([domain.close(), domain.close()]) // idempotent
    await pending // queued before close → still landed
    // Durability is the drain contract: both queued writes reached the medium.
    expect([...pool.media.get('demo')!.tables.get('items')!.keys()].sort()).toEqual(['a', 'b'])
    await expect(table.put('c', { label: 'z', count: 3 })).rejects.toMatchObject({ code: 'closed' })
    expect(() => table.get('a')).toThrow(/closed/)
    // The name is free again: reopening sees the drained state.
    const reopened = await facility.open(spec)
    expect([...reopened.table('items').keys()].sort()).toEqual(['a', 'b'])
  })

  it('facility unmount closes domains the consumer never closed', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)
    const DomainPlugin = await import('../src/index.ts')
    const fiber = await ctx.plugin(DomainPlugin, { backend: 'memory' })
    const domain = await ctx.storageDomain.open(bareSpec)
    const table = domain.table('rows')
    await table.put('a', { label: 'x', count: 1 })
    await fiber.dispose()
    await expect(table.put('b', { label: 'y', count: 2 })).rejects.toMatchObject({ code: 'closed' })
    expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)
  })

  it('contains a throwing domain/changed listener without rejecting the committed write', async () => {
    const pool = new MemoryMediaPool()
    const { ctx, facility, changes } = await harness({ pool })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    ctx.on('domain/changed', () => {
      throw new Error('hostile observer')
    })
    await expect(table.put('a', { label: 'x', count: 1 })).resolves.toBeUndefined()
    // Commit survived intact on both planes, and well-behaved listeners
    // (registered before the thrower) still observed the event.
    expect(table.get('a')).toEqual({ label: 'x', count: 1 })
    expect(pool.media.get('demo')!.tables.get('items')!.get('a')).toEqual({ label: 'x', count: 1 })
    expect(changes).toHaveLength(1)
    // The chain is unpoisoned: subsequent writes proceed normally.
    await expect(table.delete('a')).resolves.toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ISS-514：本仓收窄后的六条行为锁定
//
// 上面那批用例照抄 DSH，覆盖了行为本身；本节补的是**任务书点名、而 DSH 那批
// 没有逐字对上**的几条，以及本仓与 DSH 的两处有意分歧。
//
// 每条都写成「换成正例以外的任何实现就红」的形态：删掉被测分支、或把顺序调换，
// 断言必须变红。只写正例不算证明 —— 见每条的注释指出「删哪行会让它红」。
// ─────────────────────────────────────────────────────────────────────────────

describe('ISS-514 行为锁定', () => {
  it('deleteMany 删 3 个 key：发 3 条事件，且每条看到的事件都是整批之后的状态', async () => {
    // ⛔ 被测行为：`table.ts` 的 deleteMany 里**两个 for 循环**（先全删、再全发）。
    // 把两行合成一个循环 ⇒ observed 变成 [['b','c'], ['c'], []] ⇒ 本用例红。
    const { ctx, facility, changes } = await harness()
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })
    await table.put('b', { label: 'y', count: 2 })
    await table.put('c', { label: 'z', count: 3 })
    const seen = changes.length

    // 监听器在**事件触发的当时**读内存，记下它看到的键集合。
    const keysAtEvent: string[][] = []
    ctx.on('domain/changed', () => { keysAtEvent.push([...table.keys()].sort()) })

    await expect(table.deleteMany(['a', 'b', 'c'])).resolves.toBe(3)

    // ① 逐 key 各发一条、不合并：3 条 deleted 事件，键名各不同。
    expect(changes.slice(seen).map((c) => [c.key, c.operation])).toEqual([
      ['a', 'deleted'],
      ['b', 'deleted'],
      ['c', 'deleted'],
    ])
    // ② 三条事件里的每一次监听器运行，看到的都是【空表】——不是前缀 a/b 已删的状态。
    expect(keysAtEvent).toEqual([[], [], []])
    // ③ 介质终态与监听器所见一致：三个记录都不在了。
    expect([...domain.table('items').entries()]).toEqual([])
  })

  it('unknown-state 隔离：注入该错后 put/get/entries/keys/size/global 全抛同一错，且 close() 仍可用', async () => {
    // ⛔ 被测行为：`domain.ts` 的 enqueue 里 `this.failure = error` 那一行，
    // 与 assertReadable 里 `if (this.failure !== undefined) throw this.failure`。
    // 删掉任一处 ⇒ 下面某条断言变红（读会正常返回旧值，正是最贵的静默错）。
    const inner = new MemoryStorageBackend()
    const poisoned: StorageBackend = {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const kv = inner.kv
          if (kv === undefined) throw new Error('memory backend is missing its kv facet')
          const unit: KvUnit = await kv.open(descriptor)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: (table, key) => unit.deleteRecord(table, key),
            deleteRecords: () =>
              Promise.reject(new StorageError('unknown-state', 'unknown-state injected by the test')),
            setGlobal: (value) => unit.setGlobal(value),
            close: () => unit.close(),
          }
        },
      },
    }
    const { facility } = await harness({ backend: poisoned })
    const domain = await facility.open(spec)
    const table = domain.table('items')
    await table.put('a', { label: 'x', count: 1 })

    // 触发隔离。
    await expect(table.deleteMany(['a'])).rejects.toMatchObject({ code: 'unknown-state' })

    // ① 同步读全部抛（size 是 getter，最容易漏 —— 它单独一条断言）。
    expect(() => table.get('a')).toThrow(/unknown-state/)
    expect(() => [...table.entries()]).toThrow(/unknown-state/)
    expect(() => [...table.keys()]).toThrow(/unknown-state/)
    expect(() => table.size).toThrow(/unknown-state/)
    // ② 后续写全抛（含 global 与「本来就找不到的 key」这条早退路径）。
    await expect(table.put('b', { label: 'y', count: 2 })).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(table.delete('a')).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(table.deleteMany(['missing'])).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(table.update('a', (c) => c)).rejects.toMatchObject({ code: 'unknown-state' })
    await expect(domain.global.set({ theme: 'dark' })).rejects.toMatchObject({ code: 'unknown-state' })
    expect(() => domain.global.get()).toThrow(/unknown-state/)
    // ③ close() 仍然可用（隔离不许把释放路径也堵死）。
    await expect(domain.close()).resolves.toBeUndefined()
  })

  it('B1 校验失败报 DomainError：code=invalid-record 且 detail 含 table/key', async () => {
    // ⛔ 被测行为：`index.ts` 的 parseRecord 把 zod 失败包成 invalid-record 并带 detail。
    // 不包 ⇒ 抛的是 ZodError，code 为 undefined ⇒ 本用例红。
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness({ pool })
      await (await facility.open(spec)).table('items').put('bad', { label: 'x', count: 2 })
    }
    // 绕过 schema 直接把坏记录塞进介质（模拟「磁盘上早就有坏数据」）。
    pool.media.get('demo')!.tables.get('items')!.set('bad', { label: 'x', count: 'NaN' })
    const { facility } = await harness({ pool })
    const failure = await facility.open(spec).then(() => undefined, (e: unknown) => e)
    expect(failure).toMatchObject({
      name: 'DomainError',
      code: 'invalid-record',
      detail: { table: 'items', key: 'bad' },
    })
    // zod 的原始失败必须作为 cause 保留（诊断靠它，不能只剩一句人话）。
    expect((failure as { cause?: unknown }).cause).toBeDefined()
  })
})

// ISS-514：装配与依赖注入的用例单独一段 —— 它们判的是 `apply` 的接线
// （两个 Context 键、后端服务键的出现与消失），与上面「写语义」是两件事。
describe('ISS-514 装配与依赖注入', () => {
  it('B4 三角色齐：Definition + Provider + Domain 同挂一个 Context，Provider 注销后 Domain 不残留', async () => {
    // ⛔ 被测行为：`apply` 里 `ctx.inject(backendServices, …)` —— 后端键消失时
    // 整个 fiber 重挂，`storageDomain` 与 hub 表单键**双双**消失。
    // 少了 provide 或少了 mount ⇒ 对应断言红；只挂一半 ⇒ 那条 toThrow 红。
    const ctx = new Context()
    await ctx.plugin(Storage)                                    // ① Definition
    const backend = new MemoryStorageBackend()                   // ② Provider
    const disposeRegister = ctx.storage.backend.register('memory', backend)
    const disposeService = ctx.provide(storageBackendServiceKey('memory'), backend)
    const DomainPlugin = await import('../src/index.ts')         // ③ Domain
    const fiber = await ctx.plugin(DomainPlugin, { backend: 'memory' })

    await vi.waitFor(() => { expect(ctx.storageDomain).toBeInstanceOf(DomainFacility) })
    // 两个 Context 键必须是**同一个对象**，缺一件不算完整。
    expect(ctx.storage.domain).toBe(ctx.storageDomain)
    // npm 名字面量也算角色齐：hub 侧认得这个表单键。
    expect(ctx.storage.form('domain')).toBe(ctx.storageDomain)

    // Provider 注销 ⇒ Domain 服务键与表单键都不残留。
    disposeService()
    disposeRegister()
    await vi.waitFor(() => {
      expect(ctx.get('storageDomain')).toBeUndefined()
      expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)
    })
    await fiber.dispose()
  })

  it('依赖注入真生效：后端服务键出现之前 domain 不激活，出现后由 undefined → 实例', async () => {
    // ⛔ 被测行为：同一条 inject。把 `ctx.inject(...)` 换成直接构造 facility，
    // 第一条断言（激活前是 undefined）就红 —— 那正是「靠 yml 行序」的形态。
    const ctx = new Context()
    await ctx.plugin(Storage)
    const DomainPlugin = await import('../src/index.ts')
    const fiber = await ctx.plugin(DomainPlugin, { backend: 'memory' })

    // 后端服务键还没 publish ⇒ 回调没跑 ⇒ 两个键都取不到。
    expect(ctx.get('storageDomain')).toBeUndefined()
    expect(() => ctx.storage.form('domain')).toThrow(/not mounted/)

    const backend = new MemoryStorageBackend()
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)

    // publish 之后才成为实例。
    await vi.waitFor(() => { expect(ctx.storageDomain).toBeInstanceOf(DomainFacility) })
    expect(ctx.storage.domain).toBe(ctx.storageDomain)
    await fiber.dispose()
  })
})
