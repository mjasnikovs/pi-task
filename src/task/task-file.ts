/**
 * Task file — barrel re-export for backward compatibility.
 *
 * All existing import sites continue to work unchanged.
 *
 * @deprecated Import from the specific modules:
 *   - Types & constants: task-types.ts
 *   - Parsing & formatting: task-parsers.ts
 *   - File I/O: task-io.ts
 */

// Types (value + type re-export for union types like TaskState, PhaseName)
export type {TaskState, PhaseName, TaskFrontMatter} from './task-types.js'
export {PHASE_ORDER, PHASE_INDEX, TASKS_DIR_NAME, RESUMABLE_STATES} from './task-types.js'

// Parsing & formatting
export {
    emitFrontMatter,
    parseFrontMatter,
    sectionRegex,
    extractSection,
    normaliseTaskId
} from './task-parsers.js'

// File I/O
export {
    tasksDir,
    taskFilePath,
    ensureTasksDir,
    allocateTaskId,
    readTaskFile,
    writeTaskFile,
    updateTaskFrontMatter,
    readSection,
    setTaskSection
} from './task-io.js'
