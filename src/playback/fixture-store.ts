// The fixture-backed engine client: a real playback store over the fake engine and the fixture
// results stand-in. For UI work and tests until E11 and U8 land; X1 swaps in
// createWorkerTransport() and createResultsStore.

import { createFakeTransport, type FakeTransportOptions } from './fake-transport.ts';
import { createFixtureResultsStore } from './fixture-results.ts';
import { createPlaybackStore, type EngineClientStore, type PlaybackStoreOptions } from './store.ts';

export function createFixturePlaybackStore(
  options: Partial<PlaybackStoreOptions> & { fake?: FakeTransportOptions } = {},
): EngineClientStore {
  const { fake, ...rest } = options;
  return createPlaybackStore({
    transport: createFakeTransport(fake),
    createResults: (replicas) => createFixtureResultsStore(replicas),
    ...rest,
  });
}
