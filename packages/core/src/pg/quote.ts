const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(
      `invalid identifier ${JSON.stringify(identifier)}: must match ${IDENTIFIER_PATTERN.source}`,
    );
  }
  return `"${identifier}"`;
}
