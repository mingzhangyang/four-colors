// Minimal test harness: no framework dependency, exits non-zero on failure.

const tests = [];

export function test(name, fn) {
    tests.push({ name, fn });
}

export async function run(title) {
    let failed = 0;
    const t0 = Date.now();
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
        } catch (err) {
            failed++;
            console.error(`  ✗ ${name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`);
        }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (failed) {
        console.error(`${title}: ${failed} of ${tests.length} failed (${secs}s)`);
        process.exit(1);
    }
    console.log(`${title}: ${tests.length} passed (${secs}s)`);
}
