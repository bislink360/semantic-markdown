declare module '*.smd' {
  const content: string;
  export default content;
}
declare module '*.md' {
  const content: string;
  export default content;
}

/**
 * True only in a study build (`node scripts/build.mjs --study`, or SMD_STUDY_BUILD=1). Release builds define it as
 * false, so code behind `typeof __SMD_STUDY__ === 'boolean' && __SMD_STUDY__` is removed from the bundle. Undefined
 * when the sources run without esbuild (the unit tests). Test it at each call site: a constant re-exported from a
 * module is not folded across modules, and the code it guards would stay in the bundle.
 */
declare const __SMD_STUDY__: boolean | undefined;
