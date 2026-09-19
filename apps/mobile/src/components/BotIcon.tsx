import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedSvg = withUniwind(Svg);

/** The desktop agents glyph, using the same SVG paths on mobile. */
export function BotIcon(props: {
  readonly size?: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
  readonly strokeWidth?: number;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const size = props.size ?? 16;
  return (
    <ThemedSvg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={props.strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      color={props.color}
      colorClassName={props.colorClassName}
      style={props.style}
    >
      <Path d="M12 8V4H8" />
      <Rect width={16} height={12} x={4} y={8} rx={2} />
      <Path d="M2 14h2" />
      <Path d="M20 14h2" />
      <Path d="M15 13v2" />
      <Path d="M9 13v2" />
    </ThemedSvg>
  );
}
