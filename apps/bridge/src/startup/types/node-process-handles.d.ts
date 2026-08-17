// process._getActiveHandles is undocumented and absent from @types/node; declared optional and
// returning unknown[] so callers must feature-detect and narrow rather than cast.
declare global {
  namespace NodeJS {
    interface Process {
      _getActiveHandles?(): unknown[];
    }
  }
}

export {};
