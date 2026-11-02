import { ConnectionProfile } from '../../types';
import { getTagColor } from '../../lib/tag-colors';

/** Re-export under the historical name used across the workspace views. */
export const getTagColors = getTagColor;

export interface FavoriteGroup {
  id: string;
  name: string;
  isCollapsed?: boolean;
}

/** A connection's tags as an array, falling back to the legacy single tag. */
export const tagsOf = (conn: ConnectionProfile): { name: string; color: string }[] => {
  if (conn.tags && conn.tags.length > 0) return conn.tags;
  if (conn.tag) return [{ name: conn.tag, color: conn.tagColor || 'Gray' }];
  return [];
};

/** The last N tags to display, with how many are hidden beyond them. */
export const visibleTags = (conn: ConnectionProfile, max = 3) => {
  const all = tagsOf(conn);
  const shown = all.slice(-max);
  return { shown, overflow: all.length - shown.length };
};
