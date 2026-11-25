import { pressOpensDownloadsMenu } from "./downloadsButtonPress";

type OutsidePresses = {
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  inside: (node: EventTarget | null) => boolean;
  menuShown: () => boolean;
  onOutsidePress: (timestamp: number) => void;
};

export function watchOutsidePresses({ target, inside, menuShown, onOutsidePress }: OutsidePresses): () => void {
  const down = (event: Event) => {
    if (menuShown() || pressOpensDownloadsMenu(event as PointerEvent)) return;
    if (!inside(event.target)) onOutsidePress(event.timeStamp);
  };
  target.addEventListener("pointerdown", down, true);
  return () => target.removeEventListener("pointerdown", down, true);
}
