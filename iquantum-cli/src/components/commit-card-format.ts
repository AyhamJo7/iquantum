export function truncateCommitMessage(message: string, width = 80): string {
  const maxLength = Math.max(0, width - 8);

  if (message.length <= maxLength) {
    return message;
  }

  if (maxLength <= 1) {
    return "…".slice(0, maxLength);
  }

  return `${message.slice(0, maxLength - 1)}…`;
}

export function shortCommitHash(hash: string): string {
  return hash.slice(0, 7);
}
