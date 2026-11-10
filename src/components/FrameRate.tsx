import { cleanup, signal, Text, View } from "nsh";

/** How often the meter publishes what it counted. */
const SAMPLE_MS = 500;

/** The rate the app renders at, floating above the tool switch. Every
 * `requestAnimationFrame` callback asks for the next frame, so this is the
 * display's real rate — and while the meter runs the app renders even when
 * it has nothing else: it forces a frame on every refresh and must be off
 * while measuring idle cost. `FLOW_FPS=1` shows it; without it no loop runs. */
export function FrameRate() {
  const fps = signal(0);
  let frames = 0;
  let since: number | null = null;
  let frame = 0;
  const tick = (time: number): void => {
    frames += 1;
    if (since === null) since = time;
    const elapsed = time - since;
    if (elapsed >= SAMPLE_MS) {
      fps.set(Math.round((frames * 1000) / elapsed));
      frames = 0;
      since = time;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  cleanup(() => cancelAnimationFrame(frame));

  return (
    <View
      testID="frame-rate"
      class="absolute right-4 bottom-20 min-w-16 items-center rounded-full border border-border bg-card px-3 py-1.5"
    >
      <Text class="text-sm tabular-nums text-muted-foreground">
        {fps() === 0 ? "— fps" : `${fps()} fps`}
      </Text>
    </View>
  );
}
