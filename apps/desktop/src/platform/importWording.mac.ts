export type UnlockWords = {
  asksOnce: string;
  asks: (app: string) => string;
  firefoxAsks: (source: string, app: string) => string;
  firefoxCardKey: (source: string, key: string, app: string) => string;
  chromiumDetail: (app: string, item: string, source: string) => string;
  waiting: string;
  noAnswer: string;
  firefoxDenied: (source: string, retry: string) => string;
  denied: (item: string, retry: string) => string;
  locked: string;
  firefoxNotFound: (source: string, key: string) => string;
  notFound: (item: string, source: string) => string;
  unavailable: string;
  timeout: (retry: string) => string;
};

export const UNLOCK_WORDS: UnlockWords = {
  asksOnce: "Some data is encrypted, so your system keychain may ask for your password once for each selected profile.",
  asks: (app) => `Some data is encrypted, so your system keychain may ask for your password to bring it securely into ${app}.`,
  firefoxAsks: (source, app) => `Some of ${source}'s data is encrypted, so your system keychain may ask for your password to bring it securely into ${app}.`,
  firefoxCardKey: (source, key, app) => `${source} keeps saved card numbers under “${key}” in your system keychain, which may ask whether ${app} can read it.`,
  chromiumDetail: (app, item, source) => `${app} asks your system keychain (Secret Service or KWallet) for “${item}”: it's the key ${source} encrypts passwords, cookies, cards and open tabs with. Allow it when asked. Your data stays on this computer.`,
  waiting: "Waiting for the keychain...",
  noAnswer: "The system keychain didn't answer",
  firefoxDenied: (source, retry) => `That isn't ${source}'s primary password, or the system keychain didn't allow access. ${retry}`,
  denied: (item, retry) => `The system keychain didn't allow access to ${item}. ${retry}`,
  locked: "The system keychain is locked. Unlock it, then try again, or skip the encrypted data.",
  firefoxNotFound: (source, key) => `The system keychain has no “${key}” key, so ${source}'s saved card numbers can't be read. Skip the encrypted data to import the rest.`,
  notFound: (item, source) => `The system keychain has no ${item} key, so ${source}'s encrypted data can't be read. Skip the encrypted data to import the rest.`,
  unavailable: "No system keychain (Secret Service or KWallet) answered. Start one, then try again, or skip the encrypted data.",
  timeout: (retry) => `The system keychain didn't answer in time. ${retry}`,
};
