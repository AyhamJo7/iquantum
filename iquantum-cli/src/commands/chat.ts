import { renderAndRun } from "../app";
import { VERSION } from "../version";

export async function runChat(
  repoPath: string,
  opts: { iquantumDir?: string } = {},
): Promise<void> {
  await renderAndRun({
    version: VERSION,
    repoPath,
    chatMode: true,
    ...(opts.iquantumDir ? { iquantumDir: opts.iquantumDir } : {}),
  });
}
