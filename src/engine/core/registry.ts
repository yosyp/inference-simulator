// Static dispatch tables built once from the module list. Code, never state.

import { MAX_KIND, MAX_TOPIC } from './ids.ts';
import { MAX_PRIORITY } from './queue.ts';
import type { EngineModule, EventHandler, NoticeHandler } from './types.ts';

export interface Registry {
  readonly modules: readonly EngineModule[];
  /** By event kind. */
  readonly handlers: readonly (EventHandler | undefined)[];
  /** By event kind; -1 if the kind is not registered. */
  readonly priorities: Int32Array;
  readonly kindNames: readonly string[];
  /** By topic; undefined if nobody listens. */
  readonly subscribers: readonly (readonly NoticeHandler[] | undefined)[];
  readonly paramHooks: readonly EngineModule[];
  readonly injectHooks: readonly EngineModule[];
  readonly bucketHooks: readonly EngineModule[];
  readonly invariantHooks: readonly EngineModule[];
  readonly producer: EngineModule | null;
}

function isId(n: number, max: number): boolean {
  return Number.isInteger(n) && n >= 1 && n < max;
}

export function buildRegistry(modules: readonly EngineModule[]): Registry {
  const names = new Set<string>();
  const handlers: (EventHandler | undefined)[] = new Array<EventHandler | undefined>(MAX_KIND);
  const priorities = new Int32Array(MAX_KIND).fill(-1);
  const kindNames: string[] = new Array<string>(MAX_KIND).fill('');
  const subscribers: (NoticeHandler[] | undefined)[] = new Array<NoticeHandler[] | undefined>(
    MAX_TOPIC,
  );
  let producer: EngineModule | null = null;

  for (const m of modules) {
    const name: string = m.name;
    if (typeof name !== 'string' || name === '' || name === 'core') {
      throw new Error(`Engine module name '${name}' is empty or reserved`);
    }
    if (names.has(name)) throw new Error(`Two engine modules are named '${name}'`);
    names.add(name);
    for (const e of m.events ?? []) {
      if (!isId(e.kind, MAX_KIND)) {
        throw new Error(`${name}: event kind ${e.kind} (${e.name}) is not in [1, ${MAX_KIND})`);
      }
      if (handlers[e.kind]) {
        throw new Error(
          `${name}: event kind ${e.kind} (${e.name}) is taken by ${kindNames[e.kind]}`,
        );
      }
      if (!Number.isInteger(e.priority) || e.priority < 0 || e.priority > MAX_PRIORITY) {
        throw new Error(`${name}: priority ${e.priority} of ${e.name} is out of range`);
      }
      handlers[e.kind] = e.handle;
      priorities[e.kind] = e.priority;
      kindNames[e.kind] = e.name;
    }
    for (const n of m.notices ?? []) {
      if (!isId(n.topic, MAX_TOPIC)) {
        throw new Error(`${name}: topic ${n.topic} is not in [1, ${MAX_TOPIC})`);
      }
      (subscribers[n.topic] ??= []).push(n.handle);
    }
    if (m.produceChunk) {
      if (producer) {
        throw new Error(`Both '${producer.name}' and '${name}' define produceChunk; only one may`);
      }
      producer = m;
    }
  }

  return {
    modules,
    handlers,
    priorities,
    kindNames,
    subscribers,
    paramHooks: modules.filter((m) => m.onParams),
    injectHooks: modules.filter((m) => m.onInjected),
    bucketHooks: modules.filter((m) => m.onBucketEnd),
    invariantHooks: modules.filter((m) => m.assertInvariants),
    producer,
  };
}

export function isTopic(topic: number): boolean {
  return isId(topic, MAX_TOPIC);
}
