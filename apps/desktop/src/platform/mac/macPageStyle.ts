import { useMemo } from "react";

export * from "../../../../browser/src/state/windows/profilePager";

export function usePageStyle(_windowId: string, slot: number, width: number) {
  return useMemo(() => ({ transform: [{ translateX: slot * width }] }), [slot, width]);
}

export function useSharedTilesStyle(_windowId: string, _slot: number, _width: number, _paging: boolean) {
  return null;
}
