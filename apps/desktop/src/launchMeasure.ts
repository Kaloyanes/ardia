const IDLE_GAP_MS = 50;
const GIVE_UP_MS = 30_000;

type Clock = { now(): number; afterPaint(run: () => void): void; later(run: () => void): void };

const browserClock: Clock = {
  now: () => Date.now(),
  afterPaint: (run) => requestAnimationFrame(() => setTimeout(run, 0)),
  later: (run) => setTimeout(run, 0),
};

export function measureLaunch(committedAt: number, done: (contentAt: number, usableAt: number) => void, clock: Clock = browserClock) {
  let contentAt: number | null = null;
  let usableAt: number | null = null;
  const finish = () => {
    if (contentAt !== null && usableAt !== null) done(contentAt, Math.max(usableAt, contentAt));
  };
  clock.afterPaint(() => {
    contentAt = clock.now();
    finish();
  });
  const probe = () => {
    const set = clock.now();
    clock.later(() => {
      const now = clock.now();
      if (now - set < IDLE_GAP_MS || now - committedAt > GIVE_UP_MS) {
        usableAt = now;
        finish();
      } else probe();
    });
  };
  probe();
}
