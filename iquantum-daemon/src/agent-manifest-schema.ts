import { z } from "zod";

export const agentManifestSchema = z.object({
  name: z.string().min(1).max(128),
  prompt: z.string().min(1).max(16_384),
  inheritMemory: z.boolean().default(true),
  worktree: z.boolean().default(true),
  tools: z.array(z.string().min(1).max(256)).max(50).optional(),
  maxTurns: z.number().int().positive().optional(),
});
