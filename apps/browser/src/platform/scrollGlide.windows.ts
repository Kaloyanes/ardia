import { glideWebScroll, steerWebScroll } from "./webWheelSteer";

const hasDom = typeof document !== "undefined";

export const wheelSteersSections = hasDom;

export const glideNativeScroll = (tag: number, y: number, durationMs: number): boolean => (hasDom ? glideWebScroll(tag, y, durationMs) : false);

export const steerNativeScroll = (tag: number, lo: number, hi: number, glideMs: number, canForward: boolean, canBack: boolean): boolean =>
  hasDom ? steerWebScroll(tag, lo, hi, glideMs, canForward, canBack) : false;
