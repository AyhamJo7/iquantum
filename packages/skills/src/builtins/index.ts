import { batchSkill } from "./batch";
import { debugSkill } from "./debug";
import { doctorSkill } from "./doctor";
import { exportSkill } from "./export";

export const builtinSkills = [
  batchSkill,
  debugSkill,
  exportSkill,
  doctorSkill,
] as const;
