import type { ResolvedMode, ThemeColor, ThemeStyle } from './theme-provider';

/* Pins a subtree to a fixed theme. All axes must be set together: tokens are
   substituted at the declaring element, so a partial triple inherits the root's. */
export function ThemeScope({
  style,
  color,
  mode,
  children,
  ...divProps
}: {
  style: ThemeStyle;
  color: ThemeColor;
  mode: ResolvedMode;
} & Omit<React.ComponentProps<'div'>, 'style' | 'color' | 'data-style' | 'data-color' | 'data-mode'>) {
  return (
    <div {...divProps} data-style={style} data-color={color} data-mode={mode}>
      {children}
    </div>
  );
}
