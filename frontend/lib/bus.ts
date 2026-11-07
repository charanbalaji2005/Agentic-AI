import { useSyncExternalStore } from "react";

/**
 * Tiny app-wide command bus. The sidebar and command palette live in the shell,
 * but commands (new chat, open conversation, prefill) act on the chat page, which
 * may not be mounted yet — so unhandled commands are queued until a listener arrives.
 */
export type AppCommand =
  | { type: "new-chat" }
  | { type: "open-conversation"; id: string }
  | { type: "prefill"; text: string }
  | { type: "toggle-trace" };

type Listener = (cmd: AppCommand) => void;

const listeners = new Set<Listener>();
const queue: AppCommand[] = [];

export function emit(cmd: AppCommand) {
  if (listeners.size === 0) queue.push(cmd);
  else listeners.forEach((l) => l(cmd));
}

export function subscribe(l: Listener) {
  listeners.add(l);
  while (queue.length) l(queue.shift()!);
  return () => { listeners.delete(l); };
}

/** Shared chat state the sidebar reads: which conversation is open, and when history changed. */
type ChatState = { activeId: string | null; historyVersion: number };
let chatState: ChatState = { activeId: null, historyVersion: 0 };
const chatSubs = new Set<() => void>();

export const chatStore = {
  get: () => chatState,
  setActive(id: string | null) {
    if (chatState.activeId === id) return;
    chatState = { ...chatState, activeId: id };
    chatSubs.forEach((f) => f());
  },
  bumpHistory() {
    chatState = { ...chatState, historyVersion: chatState.historyVersion + 1 };
    chatSubs.forEach((f) => f());
  },
  subscribe(f: () => void) {
    chatSubs.add(f);
    return () => { chatSubs.delete(f); };
  },
};

export function useChatStore() {
  return useSyncExternalStore(chatStore.subscribe, chatStore.get, chatStore.get);
}
