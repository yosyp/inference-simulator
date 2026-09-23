import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simMs } from '../engine/time.ts';
import { fixtureScenarios } from '../fixtures/scenarios.ts';
import { createFakeTransport } from '../playback/fake-transport.ts';
import { createFixtureResultsStore } from '../playback/fixture-results.ts';
import { sceneAtPlayhead } from '../playback/frame.ts';
import { createManualClock, createTaskQueue } from '../playback/manual.ts';
import { createPlaybackStore } from '../playback/store.ts';
import { dotStyles } from '../ui/theme/encodings.ts';
import { SIM_CANVAS_LABEL, SimCanvas } from './SimCanvas.tsx';
import { createRecordingContext, shapes, texts, type RecordingContext } from './test-support.ts';

let ctx: RecordingContext;
let resize: ((width: number, height: number) => void) | null;
let observed = 0;

class FakeResizeObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe() {
    observed++;
    resize = (width, height) =>
      this.cb([{ contentRect: { width, height } } as ResizeObserverEntry], this as never);
  }
  unobserve() {}
  disconnect() {
    observed--;
    resize = null;
  }
}

beforeEach(() => {
  ctx = createRecordingContext();
  resize = null;
  observed = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('devicePixelRatio', 2);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Tab 5's placeholder (8 replicas), loaded, paused at its entry point at 5×: dot mode. */
function loadedStore() {
  const queue = createTaskQueue();
  const clock = createManualClock();
  const store = createPlaybackStore({
    transport: createFakeTransport({ schedule: queue.schedule }),
    createResults: (n) => createFixtureResultsStore(n),
    clock,
    frames: clock,
  });
  store.loadScenario(fixtureScenarios()[4]!);
  queue.runUntil(() => store.getState().computed.some((r) => r.toMs >= simMs(2, 11)));
  return { store, clock };
}

function mount() {
  const { store, clock } = loadedStore();
  const view = render(<SimCanvas store={store} />);
  act(() => resize?.(1000, 270));
  act(() => clock.frame());
  const canvas = screen.getByRole('img', { name: SIM_CANVAS_LABEL });
  return { store, clock, view, canvas: canvas as HTMLCanvasElement };
}

describe('SimCanvas', () => {
  it('sizes the backing store to its container at the device pixel ratio', () => {
    const { canvas } = mount();
    expect(canvas.width).toBe(2000);
    expect(canvas.height).toBe(540);
    const first = ctx.ops.find((o) => o.op === 'setTransform');
    expect(first && first.op === 'setTransform' && first.args).toEqual([2, 0, 0, 2, 0, 0]);
    ctx.reset();
    act(() => resize?.(800, 270));
    expect(canvas.width).toBe(1600);
    expect(ctx.ops.length).toBeGreaterThan(0); // redrawn at once, without waiting for the store
  });

  it('draws the scene at the playhead and redraws when it changes', () => {
    const { store, clock } = mount();
    for (let r = 1; r <= 8; r++) expect(texts(ctx)).toContain(`R${r}`);
    const decode = shapes(ctx).filter((s) => s.op === 'fill' && s.color === dotStyles.decode.fill);
    expect(decode.length).toBeGreaterThan(50);
    ctx.reset();
    clock.frame();
    expect(ctx.ops).toHaveLength(0); // nothing changed
    act(() => store.setSpeed(100));
    clock.frame();
    // Above the dot threshold: flow bars, no dots.
    const isDecodeDot = (s: ReturnType<typeof shapes>[number]) =>
      s.op === 'fill' && s.color === dotStyles.decode.fill && s.r === dotStyles.decode.radiusPx;
    expect(shapes(ctx).filter(isDecodeDot)).toHaveLength(0);
    expect(texts(ctx).some((t) => t.endsWith('tok/s'))).toBe(true);
  });

  it('describes the scene in a text alternative', () => {
    const { store, clock, canvas } = mount();
    const id = canvas.getAttribute('aria-describedby')!;
    const desc = document.getElementById(id)!;
    expect(desc.textContent).toMatch(
      /^8 replicas; highest KV \d+% on replica \d; \d+ running, \d+ waiting/,
    );
    act(() => store.setMode('highSide'));
    clock.frame();
    expect(desc.textContent).toBe('8 replicas; high side: no live telemetry');
  });

  it('tracks the analyst of a clicked dot, and ignores clicks elsewhere', () => {
    const { store, canvas } = mount();
    const scene = sceneAtPlayhead(store.getState(), store.index);
    const analysts = new Set(scene.replicas.flatMap((r) => r.dots.map((d) => d.analyst)));
    const dot = shapes(ctx).find((s) => s.op === 'fill' && s.color === dotStyles.decode.fill)!;
    const track = vi.spyOn(store, 'track');

    fireEvent.click(canvas, { clientX: 3, clientY: 3 });
    expect(track).not.toHaveBeenCalled();

    fireEvent.pointerMove(canvas, { clientX: dot.x, clientY: dot.y });
    expect(canvas.style.cursor).toBe('pointer');
    fireEvent.click(canvas, { clientX: dot.x + 1, clientY: dot.y });
    expect(track).toHaveBeenCalledTimes(1);
    const analyst = track.mock.calls[0]![0]!;
    expect(analysts.has(analyst)).toBe(true);
    expect(store.getState().trackedAnalyst).toBe(analyst);
  });

  it('stops drawing and observing when unmounted', () => {
    const { clock, view, store } = mount();
    expect(observed).toBe(1);
    view.unmount();
    expect(observed).toBe(0);
    ctx.reset();
    store.seek(simMs(2, 11));
    clock.frame();
    expect(ctx.ops).toHaveLength(0);
  });

  it('renders without a 2D context (jsdom without a canvas)', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => null);
    const { canvas } = mount();
    expect(canvas).toBeInTheDocument();
    const desc = document.getElementById(canvas.getAttribute('aria-describedby')!)!;
    expect(desc.textContent).toMatch(/^8 replicas/);
  });
});
