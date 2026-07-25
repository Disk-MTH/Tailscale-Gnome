// Zero-dependency test harness. Runs under plain `gjs -m` so the pure
// modules can be exercised without a live GNOME Shell session — anything
// importing `resource:///org/gnome/shell/…` cannot be tested here.

let _failures = 0;
let _total = 0;
const _path = [];

export function suite(name, fn) {
    _path.push(name);
    try {
        fn();
    } finally {
        _path.pop();
    }
}

export function test(name, fn) {
    _total++;
    const label = [..._path, name].join(' > ');
    try {
        fn();
    } catch (e) {
        _failures++;
        printerr(`FAIL  ${label}`);
        printerr(`      ${e.message}`);
    }
}

export function assertTrue(value, msg = '') {
    if (value !== true)
        throw new Error(`${msg || 'expected true'} — got ${JSON.stringify(value)}`);
}

export function assertFalse(value, msg = '') {
    if (value !== false)
        throw new Error(`${msg || 'expected false'} — got ${JSON.stringify(value)}`);
}

export function assertEq(actual, expected, msg = '') {
    if (actual !== expected) {
        throw new Error(
            `${msg || 'not equal'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

export function assertDeepEq(actual, expected, msg = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${msg || 'not deep-equal'} — expected ${b}, got ${a}`);
}

export function report() {
    if (_failures === 0) {
        print(`ok — ${_total} tests passed`);
        return 0;
    }
    printerr(`FAILED — ${_failures} of ${_total} tests failed`);
    return 1;
}
