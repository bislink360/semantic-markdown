// The extension's ID before 3.0 (Styled Markdown), kept apart from renamed.ts so it is tested without VS Code.

export const OLD_EXTENSION_ID = 'bislink360.styled-markdown';

/** Whether a version of the old extension is the full 2.x one (not the 3.x stub that points to the new ID). */
export function isFullOldExtension(version: unknown): boolean {
  const major = typeof version === 'string' ? Number.parseInt(version, 10) : Number.NaN;
  return Number.isFinite(major) && major < 3;
}
