import { useCallback, useInsertionEffect, useRef } from 'react';

/**
 * A callback whose identity never changes but that always runs the latest
 * `fn`. For handlers passed to memoized children: an inline handler closing
 * over state gets a new identity every render, which defeats `memo` — the
 * workspace re-rendered every open tab (each data grid and SQL editor) on any
 * update, even a sidebar drag. Not for calling during render.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  // Insertion effects run before every layout effect, children's included, so
  // a child calling this from its own effect already sees this render's `fn`.
  useInsertionEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
