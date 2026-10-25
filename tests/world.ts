import { handleMessage, saving } from '../src/service.ts';
import { Store } from '../src/ui/store.ts';
import type { Message } from '../src/shared/types.ts';

export const ID = 'eclirim-test';
export const url = (path: string) => `chrome-extension://${ID}/${path}`;
type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
/** What Chrome hands between contexts: a copy (runtime messages and storage are JSON). */
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));

/**
 * A chrome.storage.local that keeps what is written and tells every listener what changed, the way Chrome does, and the
 * real background message handler (service.ts) behind pages that each hold a real Store. `hold` keeps every write waiting
 * until it is released; `fail` makes the next write throw.
 * A page that `close`s sends what it still gathers (pagehide) and then hears nothing back: no answers, no storage changes.
 */
export function world() {
  const data: Record<string, unknown> = {}, listeners: ((changes: Changes, area: string) => void)[] = [];
  const io = { hold: null as Promise<void> | null, fail: '', writes: 0 };
  const tell = (changes: Changes) => { if (Object.keys(changes).length) setTimeout(() => { for (const listen of [...listeners]) listen(clone(changes), 'local'); }, 0); };
  const write = (items: Record<string, unknown>) => {
    const changes: Changes = {};
    for (const [key, value] of Object.entries(clone(items))) { changes[key] = { oldValue: data[key], newValue: value }; data[key] = value; }
    tell(changes);
  };
  const keys = (asked: unknown) => asked == null ? Object.keys(data) : Array.isArray(asked) ? asked as string[] : [asked as string];
  (globalThis as any).chrome = {
    runtime: { id: ID, getURL: url, sendMessage: async () => undefined },
    storage: {
      onChanged: { addListener: (listen: (changes: Changes, area: string) => void) => { listeners.push(listen); } },
      local: {
        get: async (asked?: unknown) => Object.fromEntries(keys(asked).filter(key => key in data).map(key => [key, clone(data[key])])),
        set: async (items: Record<string, unknown>) => {
          if (io.hold) await io.hold;
          if (io.fail) { const message = io.fail; io.fail = ''; throw new Error(message); }
          io.writes++; write(items);
        },
        remove: async (asked: unknown) => {
          const changes: Changes = {};
          for (const key of keys(asked)) if (key in data) { changes[key] = { oldValue: data[key] }; delete data[key]; }
          tell(changes);
        }
      },
      session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined }
    }
  };
  /** A popup or settings page with its own Store, loaded from what is stored. */
  async function page(path = 'popup.html') {
    const state = { closed: false, deaf: false, renders: 0 }, failures: string[] = [], sender = { id: ID, url: url(path) };
    // `answers` / `notices`: while set, answers wait, and storage changes are kept, to reach the page in an order a test picks.
    let answers: Promise<void> | null = null, notices: Changes[] | null = null;
    const store = new Store(message => { failures.push(message); }, async m => {
      // Delivered the moment it is sent, whatever happens to the page afterwards.
      const answer = clone(await handleMessage(clone(m) as Message, sender));
      if (answers) await answers;
      return state.closed ? new Promise(() => {}) : answer;
    });
    store.onChange = () => { state.renders++; };
    const hear = (changes: Changes) => { if (store.adopt(changes as Record<string, chrome.storage.StorageChange>)) state.renders++; };
    listeners.push((changes, area) => { if (state.closed || state.deaf || area !== 'local') return; if (notices) notices.push(changes); else hear(changes); });
    await store.load();
    return { store, state, failures, sender,
      /** The page goes away. It is assumed to have sent what it still gathered (`flush`, as on pagehide); that this reaches the background in a real browser is for the browser tests to show. */
      close: () => { store.flush(); state.closed = true; },
      /** Answers to this page wait until the function returned is called. */
      holdAnswers: () => { let release!: () => void; answers = new Promise<void>(resolve => { release = () => { answers = null; resolve(); }; }); return release; },
      /** Storage changes for this page are kept until the function returned is called, then heard in order. */
      holdNotices: () => { notices = []; return () => { const kept = notices || []; notices = null; for (const changes of kept) hear(changes); }; } };
  }
  /** Keeps every write waiting until the function returned is called. */
  const hold = () => { let release!: () => void; io.hold = new Promise<void>(resolve => { release = () => { io.hold = null; resolve(); }; }); return release; };
  /** Once everything the background was given is written and every page has heard of it. */
  const idle = async () => { for (let i = 0; i < 3; i++) { await saving(async () => undefined); await new Promise(resolve => setTimeout(resolve, 0)); } };
  /** What is stored, put there before any page opens. */
  const seed = (items: Record<string, unknown>) => { Object.assign(data, clone(items)); };
  const done = () => { delete (globalThis as any).chrome; };
  return { data, io, page, hold, idle, seed, write, done };
}
