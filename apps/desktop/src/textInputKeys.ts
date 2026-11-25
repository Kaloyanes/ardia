const IME_PROCESS_KEY = 229;

export const isImeKey = (e: Pick<KeyboardEvent, "isComposing" | "keyCode">) => !!e.isComposing || e.keyCode === IME_PROCESS_KEY;
