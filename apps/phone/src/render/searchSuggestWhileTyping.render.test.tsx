import { act } from "react-test-renderer";
import { dismissSearch, presentSearch, searchState, typeSearch } from "../state/search/store";
import { withTabs } from "../../test/render/harness";

type Asked = { url: string; answer: (body: string) => void; signal: AbortSignal | undefined };

let asked: Asked[] = [];
const realFetch = global.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(2);
  asked = [];
  global.fetch = jest.fn(
    (url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((done) => {
        asked.push({ url: String(url), signal: init?.signal ?? undefined, answer: (body) => done({ status: 200, text: async () => body } as Response) });
      }),
  ) as typeof fetch;
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  global.fetch = realFetch;
  jest.useRealTimers();
});

const KEY_EVERY_MS = 100;

const queryTitles = () => searchState().rows.flatMap((row) => (row.kind === "query" ? [row.title.toLowerCase()] : []));

test("the engine's suggestions reach the rows while someone keeps typing, not only once they pause", async () => {
  act(() => presentSearch("home", ""));
  const word = "otters";
  act(() => typeSearch(word.slice(0, 1)));
  act(() => jest.advanceTimersByTime(KEY_EVERY_MS));
  act(() => typeSearch(word.slice(0, 2)));
  act(() => jest.advanceTimersByTime(KEY_EVERY_MS));
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((request) => !request.signal?.aborted)).toBe(true);
  await act(async () => {
    asked[0]?.answer(JSON.stringify(["o", ["otters facts", "oil prices", "otter pops"]]));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => typeSearch(word.slice(0, 3)));
  act(() => jest.advanceTimersByTime(KEY_EVERY_MS));
  expect(searchState().text).toBe("ott");
  expect(queryTitles()).toEqual(expect.arrayContaining(["otters facts", "otter pops"]));
  expect(queryTitles()).not.toContain("oil prices");
});
