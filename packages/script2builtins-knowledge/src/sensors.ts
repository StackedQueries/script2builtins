import type { ApiDefinition } from "./types.js";

export const sensorApis: ApiDefinition[] = [
  {
    key: "DeviceMotionEvent",
    category: "sensors",
    severity: "medium",
    botDetectionTell: true,
    description: "Capability check. Headless desktop browsers expose it but never fire; mobile-claiming UAs that don't fire DeviceMotion are flagged.",
  },
  {
    key: "DeviceOrientationEvent",
    category: "sensors",
    severity: "medium",
    botDetectionTell: true,
    description: "Same family as DeviceMotionEvent — expected to fire on real mobile.",
  },
  {
    key: "TouchEvent",
    category: "sensors",
    severity: "medium",
    description: "Touch capability check. Combined with maxTouchPoints and pointer media-queries.",
  },
  {
    key: "PointerEvent",
    category: "sensors",
    severity: "low",
    description: "Pointer event capability.",
  },
  {
    key: "Gyroscope",
    category: "sensors",
    severity: "medium",
    description: "Generic Sensor API class. Modern but rarely fingerprinted alone.",
  },
  {
    key: "Accelerometer",
    category: "sensors",
    severity: "medium",
    description: "Generic Sensor API class.",
  },
  {
    key: "AmbientLightSensor",
    category: "sensors",
    severity: "info",
    description: "Behind feature flag in most browsers.",
  },
  {
    key: "LinearAccelerationSensor",
    category: "sensors",
    severity: "medium",
    description: "Generic Sensor API class; constructor presence is a capability probe.",
  },
  {
    key: "GravitySensor",
    category: "sensors",
    severity: "medium",
    description: "Generic Sensor API class.",
  },
  {
    key: "AbsoluteOrientationSensor",
    category: "sensors",
    severity: "medium",
    description: "Generic Sensor API class.",
  },
  {
    key: "RelativeOrientationSensor",
    category: "sensors",
    severity: "medium",
    description: "Generic Sensor API class.",
  },
  {
    key: "Magnetometer",
    category: "sensors",
    severity: "medium",
    description: "Generic Sensor API class.",
  },
  {
    key: "Sensor",
    category: "sensors",
    severity: "info",
    description: "Base class presence check.",
  },
];
