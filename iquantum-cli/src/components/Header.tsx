import { basename } from "node:path";
import { Box, Text } from "ink";
import { LOGO } from "./theme";

export interface HeaderProps {
  version: string;
  modelName: string;
  repoPath: string;
}

export function Header({ version, modelName, repoPath }: HeaderProps) {
  const repo = basename(repoPath) || repoPath;
  return (
    <Box marginBottom={1}>
      <Text bold>{LOGO} iquantum</Text>
      <Text dimColor>
        {" "}
        · v{version} · {modelName} · {repo}
      </Text>
    </Box>
  );
}
