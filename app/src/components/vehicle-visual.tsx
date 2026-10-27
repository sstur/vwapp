import body from "@/assets/vehicle/idbuzz_2024_body.png";
import doorFrontLeftClosed from "@/assets/vehicle/idbuzz_2024_door_front_left_closed.png";
import doorFrontLeftOpen from "@/assets/vehicle/idbuzz_2024_door_front_left_open.png";
import doorFrontRightClosed from "@/assets/vehicle/idbuzz_2024_door_front_right_closed.png";
import doorFrontRightOpen from "@/assets/vehicle/idbuzz_2024_door_front_right_open.png";
import doorRearLeftClosed from "@/assets/vehicle/idbuzz_2024_door_rear_left_closed.png";
import doorRearLeftOpen from "@/assets/vehicle/idbuzz_2024_door_rear_left_open.png";
import tailgateOpen from "@/assets/vehicle/idbuzz_2024_door_rear_open.png";
import doorRearRightClosed from "@/assets/vehicle/idbuzz_2024_door_rear_right_closed.png";
import doorRearRightOpen from "@/assets/vehicle/idbuzz_2024_door_rear_right_open.png";
import doorWindowFrontLeftOpen from "@/assets/vehicle/idbuzz_2024_door_window_front_left_open.png";
import doorWindowFrontRightOpen from "@/assets/vehicle/idbuzz_2024_door_window_front_right_open.png";
import doorWindowRearLeftOpen from "@/assets/vehicle/idbuzz_2024_door_window_rear_left_open.png";
import doorWindowRearRightOpen from "@/assets/vehicle/idbuzz_2024_door_window_rear_right_open.png";
import hoodOpen from "@/assets/vehicle/idbuzz_2024_engine_hood_open.png";
import windowFrontLeftOpen from "@/assets/vehicle/idbuzz_2024_window_front_left_open.png";
import windowFrontRightOpen from "@/assets/vehicle/idbuzz_2024_window_front_right_open.png";
import windowRearLeftOpen from "@/assets/vehicle/idbuzz_2024_window_rear_left_open.png";
import windowRearRightOpen from "@/assets/vehicle/idbuzz_2024_window_rear_right_open.png";
import { DOOR_SIDES, type DoorSide } from "@/closures";
import { Image, StyleSheet, type ImageSourcePropType } from "react-native";
import { View } from "tamagui";

// The body layer has every door closed; the *_closed layers only add trim
// (mirrors) and the *_open layers draw that door swung open in red.
const DOOR_CLOSED: Record<DoorSide, ImageSourcePropType> = {
  "front left": doorFrontLeftClosed,
  "front right": doorFrontRightClosed,
  "rear left": doorRearLeftClosed,
  "rear right": doorRearRightClosed,
};
const DOOR_OPEN: Record<DoorSide, ImageSourcePropType> = {
  "front left": doorFrontLeftOpen,
  "front right": doorFrontRightOpen,
  "rear left": doorRearLeftOpen,
  "rear right": doorRearRightOpen,
};
// An open window is drawn in place on a closed door, but on the swung-out
// panel when that door is open too — hence two variants per side.
const WINDOW_OPEN: Record<DoorSide, ImageSourcePropType> = {
  "front left": windowFrontLeftOpen,
  "front right": windowFrontRightOpen,
  "rear left": windowRearLeftOpen,
  "rear right": windowRearRightOpen,
};
const DOOR_WINDOW_OPEN: Record<DoorSide, ImageSourcePropType> = {
  "front left": doorWindowFrontLeftOpen,
  "front right": doorWindowFrontRightOpen,
  "rear left": doorWindowRearLeftOpen,
  "rear right": doorWindowRearRightOpen,
};

/**
 * Top-down render of the ID. Buzz with open doors/windows highlighted in red —
 * the stock myVW app's own layered art. Every layer shares one 1056×1188
 * canvas, so stacking absolutely-positioned images composites exactly.
 */
export function VehicleVisual({
  openDoors,
  openWindows,
}: {
  openDoors: string[];
  openWindows: string[];
}) {
  const doors = new Set(openDoors);
  const windows = new Set(openWindows);

  const layers: ImageSourcePropType[] = [body];
  for (const side of DOOR_SIDES) {
    layers.push(doors.has(side) ? DOOR_OPEN[side] : DOOR_CLOSED[side]);
  }
  if (doors.has("trunk")) layers.push(tailgateOpen);
  if (doors.has("hood")) layers.push(hoodOpen);
  for (const side of DOOR_SIDES) {
    if (windows.has(side)) {
      layers.push(doors.has(side) ? DOOR_WINDOW_OPEN[side] : WINDOW_OPEN[side]);
    }
  }

  const open = [...openDoors, ...openWindows.map((w) => `${w} window`)];
  return (
    <View
      width="100%"
      aspectRatio={1056 / 1188}
      accessibilityRole="image"
      accessibilityLabel={
        open.length > 0
          ? `Vehicle with ${open.join(", ")} open`
          : "Vehicle with all doors and windows closed"
      }
    >
      {layers.map((source, i) => (
        <Image
          key={i}
          source={source}
          style={i === 0 ? styles.base : styles.layer}
          resizeMode="contain"
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { width: "100%", height: "100%" },
  // Edge-anchored absoluteFill leaves Image at its intrinsic size here
  // (Expo Go / new arch); size the overlays explicitly instead.
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
  },
});
