// Entry point: `make test`, or `gjs -m tests/run.js`.
import System from 'system';

import { report } from './harness.js';

import './notify-policy.test.js';
import './tailscale.test.js';
import './watchers.test.js';

System.exit(report());
