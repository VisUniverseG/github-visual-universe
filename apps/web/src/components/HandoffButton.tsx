import { useCallback, type ReactNode, type RefObject } from 'react';

/**
 * A button that is replaced once it has been used (by a loading state, say). If it still has
 * focus at the moment it is removed, focus goes to `focusTarget` instead of falling back to the
 * page. A button that stays (a request that was refused, for instance) keeps focus, and a button
 * removed while something else has focus changes nothing.
 */
export function HandoffButton({
  focusTarget,
  onClick,
  children,
}: {
  readonly focusTarget: RefObject<HTMLElement | null>;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  // The callback ref's cleanup runs as the button is detached, while it is still in the page, so
  // `document.activeElement` still says whether it had focus. It must keep its identity (it only
  // changes with `focusTarget`, which is a ref object): a new one would detach and re-attach the
  // button on every render, and the cleanup would then move focus for no reason.
  const watchFocus = useCallback(
    (button: HTMLButtonElement) => () => {
      if (document.activeElement === button) focusTarget.current?.focus();
    },
    [focusTarget],
  );
  return (
    <button ref={watchFocus} type="button" onClick={onClick}>
      {children}
    </button>
  );
}
