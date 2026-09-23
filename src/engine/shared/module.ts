// The shared slice: the request table and meters. First in module order, so every other module's
// init can see it. It frees request slots after requestEnded (see requests.ts).

import { defineModule } from '../core/types.ts';
import { TOPIC } from '../core/ids.ts';
import { createMeters, type Meters } from './meters.ts';
import {
  assertRequestTable,
  createRequestTable,
  releaseRequest,
  type RequestTable,
} from './requests.ts';

export interface SharedSlice {
  requests: RequestTable;
  meters: Meters;
}

declare module '../core/types.ts' {
  interface DayState {
    shared: SharedSlice;
  }
}

export const sharedModule = defineModule({
  name: 'shared',
  init(_state, ctx) {
    return {
      requests: createRequestTable(),
      meters: createMeters(ctx.input.config.replicas, ctx.nowMs),
    };
  },
  notices: [
    {
      topic: TOPIC.requestEnded,
      handle(state, n) {
        releaseRequest(state.shared.requests, n.a);
      },
    },
  ],
  assertInvariants(state) {
    assertRequestTable(state.shared.requests);
  },
});
