// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Entry point: `make test`, or `gjs -m tests/run.js`.
import System from 'system';

import { report } from './harness.js';

import './client-poll.test.js';
import './notify-policy.test.js';
import './spawn.test.js';
import './tailscale.test.js';
import './watchers.test.js';

System.exit(report());
