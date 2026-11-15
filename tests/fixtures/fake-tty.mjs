/**
 * Test-only preload for `node --import`.
 *
 * The interactive picker only runs when stdin reports itself as a TTY. This
 * module flips that one property before dsh-ask.mjs is loaded, so the real
 * production code path runs unchanged while the picker can be driven over a
 * pipe. Production behavior is never changed for the sake of a test: nothing
 * here is imported by the CLI itself.
 */
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
