export function errorMessage(error: unknown) {
  if (!error) {
    return "";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error).replace(/^Error:\s*/i, "");
}

export function compactError(error: unknown) {
  const message = errorMessage(error).replace(/\s+/g, " ").trim();
  if (message.length <= 220) {
    return message;
  }

  return `${message.slice(0, 217)}...`;
}

function compactDebugValue(value: unknown) {
  return String(value ?? "-")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, "_")
    .slice(0, 180);
}

export function formatDebugDetails(details: Record<string, unknown>) {
  return Object.entries(details)
    .map(([key, value]) => `${key}=${compactDebugValue(value)}`)
    .join(" ");
}
