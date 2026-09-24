/* The three theme axes. Single source for the provider and the pickers. */
export const THEME_STYLE_VALUES = ['retro', 'modern'] as const;
export const THEME_COLOR_VALUES = ['violet', 'blue', 'green', 'pink', 'gold'] as const;
export const THEME_MODE_VALUES = ['dark', 'light', 'system'] as const;

export type ThemeStyle = (typeof THEME_STYLE_VALUES)[number];
export type ThemeColor = (typeof THEME_COLOR_VALUES)[number];
export type ModePreference = (typeof THEME_MODE_VALUES)[number];
export type ResolvedMode = Exclude<ModePreference, 'system'>;
