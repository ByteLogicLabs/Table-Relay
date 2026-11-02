/** Badge styling for connection metadata, driven by theme tokens so it
 *  re-tints with the active theme.
 *
 *  The DB-type label stays neutral — the colored driver icon already signals
 *  which database it is, so a colored text badge would be redundant. Only the
 *  SSH badge gets an accent so a tunneled connection stands out at a glance. */

/** DB-type label badge: neutral, since the icon already conveys the type. */
export function getDriverColor(_driver: string): { bg: string; text: string } {
  return { bg: 'bg-muted', text: 'text-muted-foreground' };
}

/** SSH badge — the theme's accent/primary color so a tunneled connection is
 *  immediately visible. Theme-driven, so it adapts per theme. */
export const SSH_BADGE_CLASS = 'bg-primary/15 text-primary font-medium';
