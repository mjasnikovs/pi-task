import {test} from 'bun:test'

/** For what Windows has no equivalent of: signals, process groups, shebang scripts. */
export const testPosix = test.skipIf(process.platform === 'win32')
