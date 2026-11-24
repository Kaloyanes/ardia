import type { FieldTiming } from "./fieldTiming";

export const fieldTiming: FieldTiming = {
  pageMarks: false,
  setEnabled() {},
  markFrame() {},
  lastInput: () => [0, 0],
  drain: () => [],
};
