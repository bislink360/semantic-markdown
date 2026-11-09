// Whether a build is the Study 2 study build, and what it defines. A study build logs study sessions (src/study/);
// every other build, including every release, defines __SMD_STUDY__ as false so that code is removed from the
// bundle. The study build is never released: see docs/maintainers/study-build.md.

/** The environment variable that asks for a study build (so `vsce package`'s prepublish build can be one). */
export const STUDY_BUILD_ENV = 'SMD_STUDY_BUILD';

/** Strings only the study code holds: a bundle that contains one includes the study logging. */
export const STUDY_MARKERS = ['SMD_STUDY_LOG', 'smd._studyToggle', 'studyCue'];

/** The study page script's output, relative to extension/. A release build deletes it. */
export const STUDY_PAGE_SCRIPT = 'dist/webview/study-cues.js';

/** True for `build.mjs --study` or SMD_STUDY_BUILD=1. */
export function isStudyBuild(argv = process.argv, env = process.env) {
  return argv.includes('--study') || env[STUDY_BUILD_ENV] === '1';
}

/** esbuild `define` entries for the build. */
export function studyDefine(study) {
  return { __SMD_STUDY__: study ? 'true' : 'false' };
}
